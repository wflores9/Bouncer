import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder,
  Events, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits,
} from 'discord.js';
import { scanMessage, checkName, classifyHost, extractHosts } from './detect.js';
import { RaidWatch } from './raid.js';
import { FloodWatch } from './flood.js';
import { Store } from './store.js';
import { loadConfig, effectiveConfig } from './config.js';
import { strikeAction, clampTimeoutMinutes, formatMinutes } from './strikes.js';
import {
  XrplClient, isValidAddress, isTxHash, formatAmount, hexToAscii, rippleTime, cleanDomain, fetchLedgerToml, currencyName,
} from './xrpl.js';
import { Xaman } from './xaman.js';
import { qualifyingRoles, describeRule } from './holders.js';
import { commands } from './commands.js';
import { line } from './voice.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = loadConfig(process.env.BOUNCER_CONFIG ?? resolve(ROOT, 'config.json'));
const store = new Store(resolve(ROOT, base.dataFile));
let cfg = effectiveConfig(base, store.data.lists);
const refreshCfg = () => { cfg = effectiveConfig(base, store.data.lists); };

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const xrpl = new XrplClient(process.env.XRPL_RPC ? process.env.XRPL_RPC.split(',') : base.xrpl.rpc);
const xaman = new Xaman(process.env.XAMAN_API_KEY, process.env.XAMAN_API_SECRET);

const COLORS = { remove: 0xc0392b, secret: 0x8e44ad, flag: 0xc8a94a, info: 0x2c6fbb, raid: 0xe67e22, ok: 0x27ae60 };
const DAY = 86_400_000;
const EPH = MessageFlags.Ephemeral;
const startedAt = Date.now();
const stats = { removed: 0, flagged: 0, secrets: 0, timeouts: 0, joinsFlagged: 0, raids: 0, floods: 0, entered: 0, warns: 0 };
const raid = new RaidWatch(base.raid);
const flood = new FloodWatch(base.flood);
const linking = new Set(); // users with an open Xaman request
let staffNames = [];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // Partials let edits to messages sent before a restart still reach MessageUpdate.
  partials: [Partials.Message, Partials.Channel],
});

// ---------- helpers ----------

function isStaff(member) {
  if (!member) return false;
  if (member.user?.bot) return true;
  if (member.permissions?.has(PermissionFlagsBits.ManageMessages)) return true;
  return cfg.exemptRoleIds.some((id) => member.roles?.cache?.has(id));
}

const ageDays = (user) => (Date.now() - user.createdTimestamp) / DAY;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const xrpscan = (kind, id) => `https://xrpscan.com/${kind}/${id}`;

function excerpt(text, redact = false) {
  if (redact) return '`[redacted: contained a wallet secret]`';
  const clean = (text || '(no text)').replace(/`/g, "'").slice(0, 600);
  return `\`\`\`\n${clean}\n\`\`\``;
}

async function modlog(payload) {
  try {
    const ch = await client.channels.fetch(cfg.modlogChannelId);
    return await ch.send(payload);
  } catch (err) {
    console.error('modlog send failed:', err.message);
    return null;
  }
}

async function timeout(member, reason, minutes = cfg.timeoutMinutes) {
  const m = clampTimeoutMinutes(minutes);
  try {
    await member.timeout(m * 60_000, `Bouncer: ${reason}`.slice(0, 500));
    stats.timeouts += 1;
    return `Timed out ${formatMinutes(m)}`;
  } catch (err) {
    return `Timeout failed (${err.message}). Check Bouncer's role is above theirs.`;
  }
}

async function notice(channel, text, seconds = 12) {
  try {
    const msg = await channel.send({ content: text, allowedMentions: { parse: ['users'] } });
    setTimeout(() => msg.delete().catch(() => {}), seconds * 1000);
  } catch { /* no send permission in that channel */ }
}

function buttons(userId, timedOut) {
  const row = new ActionRowBuilder();
  if (timedOut) {
    row.addComponents(new ButtonBuilder().setCustomId(`bouncer:untimeout:${userId}`).setLabel('Lift timeout').setStyle(ButtonStyle.Secondary));
  } else {
    row.addComponents(new ButtonBuilder().setCustomId(`bouncer:timeout:${userId}`).setLabel(`Timeout ${formatMinutes(cfg.timeoutMinutes)}`).setStyle(ButtonStyle.Danger));
  }
  row.addComponents(new ButtonBuilder().setCustomId('bouncer:handled').setLabel('Handled').setStyle(ButtonStyle.Success));
  return [row];
}

function baseEmbed(kind, user, title) {
  return new EmbedBuilder()
    .setColor(COLORS[kind] ?? COLORS.info)
    .setAuthor({ name: `${user.tag ?? user.username} · ${user.id}`, iconURL: user.displayAvatarURL() })
    .setTitle(title)
    .setFooter({ text: 'Bouncer' })
    .setTimestamp();
}

async function refreshStaffNames(guild) {
  try {
    const members = await guild.members.fetch();
    staffNames = members
      .filter((m) => !m.user.bot && m.permissions.has(PermissionFlagsBits.ManageMessages))
      .flatMap((m) => [m.user.username, m.user.globalName, m.nickname].filter(Boolean));
  } catch (err) {
    console.error('Could not load staff names:', err.message);
  }
}

/**
 * Record a strike and escalate if a step is reached.
 * @returns {Promise<{count:number, step:object|null, escalated:string|null, caseId:number}>}
 */
async function strike(member, user, type, reason, modId = null, alreadyTimedOutMinutes = 0) {
  const c = store.addCase({ userId: user.id, type, reason, modId });
  const count = store.strikeCount(user.id, base.strikes.expireDays);
  const step = strikeAction(count, base.strikes.steps);
  let escalated = null;
  if (step && member && step.timeoutMinutes > alreadyTimedOutMinutes) {
    escalated = await timeout(member, `strike ${count}: ${reason}`, step.timeoutMinutes);
  }
  return { count, step, escalated, caseId: c.id };
}

function strikeField(s) {
  let v = `Case #${s.caseId} · ${s.count} active strike${s.count === 1 ? '' : 's'} (${base.strikes.expireDays}d window)`;
  if (s.escalated) v += `\nEscalated: ${s.escalated}`;
  if (s.step?.top) v += '\n**Top step reached. Consider a ban.**';
  return { name: 'Strikes', value: v };
}

// ---------- message screening ----------

async function deleteRefs(refs) {
  await Promise.all(refs.map(async ({ channelId, messageId }) => {
    const ch = client.channels.cache.get(channelId);
    await ch?.messages?.delete(messageId).catch(() => {});
  }));
}

async function screen(message, { isEdit = false } = {}) {
  if (!message.guild || message.guild.id !== cfg.guildId) return;
  if (message.author?.bot || message.system) return;
  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (isStaff(member)) return;

  const result = scanMessage({
    content: message.content,
    mentionCount: message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 99 : 0),
    accountAgeDays: ageDays(message.author),
  }, cfg);

  const where = `${message.channel} · [jump](${message.url})`;
  const user = message.author;

  if (result.verdict === 'secret') {
    stats.secrets += 1;
    await message.delete().catch(() => {});
    const warnText = `${line('secret')} Your message was removed. If that was a real wallet secret, treat the wallet as compromised and move funds to a new one now.`;
    const dm = await user.send(warnText).then(() => true).catch(() => false);
    if (!dm) await notice(message.channel, `${user} ${warnText}`, 30);
    await modlog({
      embeds: [baseEmbed('secret', user, '🔐 Wallet secret posted, removed')
        .addFields(
          { name: 'Where', value: where },
          { name: 'Why', value: result.reasons.join('\n') },
          { name: 'Action', value: `Deleted. ${dm ? 'User warned by DM.' : 'DMs closed, warned in channel.'} No timeout (likely a victim).` },
          { name: 'Message', value: excerpt('', true) },
        )],
    });
    return;
  }

  if (result.verdict === 'remove') {
    stats.removed += 1;
    await message.delete().catch(() => {});
    const t = member ? await timeout(member, result.reasons[0]) : 'Not a member, no timeout';
    const s = await strike(member, user, 'auto', result.reasons[0], null, cfg.timeoutMinutes);
    await notice(message.channel, `${line('remove')} (${user})`);
    await modlog({
      embeds: [baseEmbed('remove', user, `🚪 ${line('remove')}`)
        .addFields(
          { name: 'Where', value: where },
          { name: 'Why', value: result.reasons.join('\n').slice(0, 1000) },
          { name: 'Action', value: `Deleted. ${t}` },
          strikeField(s),
          { name: 'Account age', value: `${ageDays(user).toFixed(1)} days`, inline: true },
          { name: 'Message', value: excerpt(message.content) },
        )],
      components: buttons(user.id, t.startsWith('Timed out') || Boolean(s.escalated?.startsWith('Timed out'))),
    });
    return;
  }

  // Flood / duplicate spam (new messages only; edits would double count).
  if (!isEdit) {
    const f = flood.record({ userId: user.id, channelId: message.channelId, messageId: message.id, content: message.content });
    if (f.verdict !== 'none') {
      stats.floods += 1;
      await deleteRefs(f.messages);
      const t = member ? await timeout(member, `${f.verdict}: ${f.reason}`) : 'Not a member, no timeout';
      const s = await strike(member, user, 'auto', `${f.verdict}: ${f.reason}`, null, cfg.timeoutMinutes);
      await notice(message.channel, `${line('flood')} (${user})`);
      await modlog({
        embeds: [baseEmbed('remove', user, `🌊 ${f.verdict === 'flood' ? 'Flooding' : 'Copy-paste spam'}, cleared`)
          .addFields(
            { name: 'Where', value: where },
            { name: 'Why', value: f.reason },
            { name: 'Action', value: `Deleted ${f.messages.length} message${f.messages.length === 1 ? '' : 's'}. ${t}` },
            strikeField(s),
            { name: 'Message', value: excerpt(message.content) },
          )],
        components: buttons(user.id, t.startsWith('Timed out')),
      });
      return;
    }
  }

  if (result.verdict === 'none') return;

  stats.flagged += 1;
  await modlog({
    embeds: [baseEmbed('flag', user, `👀 ${line('flag')}`)
      .addFields(
        { name: 'Where', value: where },
        { name: 'Why', value: result.reasons.join('\n').slice(0, 1000) },
        { name: 'Account age', value: `${ageDays(user).toFixed(1)} days`, inline: true },
        { name: 'Message', value: excerpt(message.content) },
      )],
    components: buttons(user.id, false),
  });
}

// ---------- door checks (joins + name changes) ----------

async function checkMemberName(member, context) {
  if (isStaff(member)) return;
  const names = [member.user.username, member.user.globalName, member.nickname].filter(Boolean);
  const targets = [...cfg.protectedNames, ...staffNames];
  for (const name of names) {
    const hit = checkName(name, targets);
    if (!hit) continue;
    stats.joinsFlagged += 1;
    const t = hit.level === 'exact' ? await timeout(member, `impersonating "${hit.target}"`) : 'Flag only';
    await modlog({
      embeds: [baseEmbed(hit.level === 'exact' ? 'remove' : 'flag', member.user, `🎭 ${line('impersonation')}`)
        .addFields(
          { name: 'Name', value: `\`${name}\` looks like **${hit.target}** (${hit.level})` },
          { name: 'When', value: context, inline: true },
          { name: 'Account age', value: `${ageDays(member.user).toFixed(1)} days`, inline: true },
          { name: 'Action', value: t },
        )],
      components: buttons(member.id, t.startsWith('Timed out')),
    });
    return;
  }
}

async function welcome(member) {
  const channelId = store.get('welcomeChannelId');
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    await ch.send({ content: `${line('welcome')} Welcome to the Club, ${member}.`, allowedMentions: { users: [member.id] } });
  } catch (err) { console.error('welcome:', err.message); }
}

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== cfg.guildId || member.user.bot) return;
  const age = ageDays(member.user);

  if (raid.record()) {
    stats.raids += 1;
    await modlog({
      embeds: [new EmbedBuilder().setColor(COLORS.raid).setTitle(`🚨 ${line('raid')}`)
        .setDescription(`${base.raid.joins}+ joins in ${base.raid.windowSeconds}s. Raid mode is on for ${base.raid.durationMinutes} min.${base.raid.timeoutNewAccounts ? ` New accounts (< ${cfg.minAccountAgeDays}d) are timed out on join.` : ''}\nTurn it off early with \`/bouncer raid off\`.`)
        .setFooter({ text: 'Bouncer' }).setTimestamp()],
    });
  }

  if (raid.isActive() && base.raid.timeoutNewAccounts && age < cfg.minAccountAgeDays) {
    const t = await timeout(member, 'joined during raid mode with a new account');
    await modlog({
      embeds: [baseEmbed('raid', member.user, '🚧 Held at the door (raid mode)')
        .addFields({ name: 'Account age', value: `${age.toFixed(1)} days`, inline: true }, { name: 'Action', value: t, inline: true })],
      components: buttons(member.id, t.startsWith('Timed out')),
    });
    return;
  }

  if (age < cfg.minAccountAgeDays) {
    stats.joinsFlagged += 1;
    await modlog({
      embeds: [baseEmbed('flag', member.user, '🆕 Fresh account at the door')
        .addFields({ name: 'Account age', value: `${age.toFixed(1)} days`, inline: true })],
    });
  }
  await checkMemberName(member, 'on join');
  if (!store.get('gate')) await welcome(member); // with the gate on, welcome happens on entry
  if (store.walletOf(member.id)) syncHolder(member).catch(() => {}); // rejoining holder
});

client.on(Events.GuildMemberUpdate, async (before, after) => {
  if (after.guild.id !== cfg.guildId) return;
  if (before.partial || before.nickname !== after.nickname) {
    await checkMemberName(after, 'nickname change');
  }
});

// Username and display-name changes are account-wide, so they arrive as UserUpdate.
client.on(Events.UserUpdate, async (before, after) => {
  if (after.bot) return;
  if (!before.partial && before.username === after.username && before.globalName === after.globalName) return;
  try {
    const guild = await client.guilds.fetch(cfg.guildId);
    const member = await guild.members.fetch(after.id).catch(() => null);
    if (member) await checkMemberName(member, 'name change');
  } catch (e) { console.error('user update:', e); }
});

// ---------- messages ----------

client.on(Events.MessageCreate, (m) => screen(m).catch((e) => console.error('screen:', e)));
client.on(Events.MessageUpdate, async (before, after) => {
  try {
    if (after.partial) after = await after.fetch();
    // Embed unfurls fire updates too. A partial "before" has no content, so re-check it.
    if (!before.partial && before.content === after.content) return;
    await screen(after, { isEdit: true });
  } catch (e) { console.error('edit screen:', e); }
});

// ---------- report bridge (Ticket Tool) ----------

client.on(Events.ChannelCreate, async (channel) => {
  if (channel.guild?.id !== cfg.guildId || channel.type !== ChannelType.GuildText) return;
  if (!channel.name.toLowerCase().includes(cfg.reportTicketPrefix)) return;
  try {
    const staff = await client.channels.fetch(cfg.staffChannelId);
    await staff.send({
      embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🚨 New private report')
        .setDescription(`${channel} was just opened. Someone is waiting on a mod.`)
        .setFooter({ text: 'Bouncer' }).setTimestamp()],
    });
  } catch (err) { console.error('report bridge:', err.message); }
});

// ---------- holder roles ----------

/** Add/remove holder-rule roles for one member. Never removes on an XRPL error. */
async function syncHolder(member) {
  const rules = store.rules();
  if (!rules.length) return { added: [], removed: [] };
  const w = store.walletOf(member.id);
  let qualifies;
  try {
    qualifies = w ? await qualifyingRoles(w.address, rules, xrpl) : new Set();
  } catch (e) {
    console.error(`holder check ${member.id}:`, e.message);
    return { added: [], removed: [], error: e.message };
  }
  const added = [];
  const removed = [];
  for (const roleId of new Set(rules.map((r) => r.roleId))) {
    const role = member.guild.roles.cache.get(roleId);
    if (!role?.editable) continue;
    const has = member.roles.cache.has(roleId);
    if (qualifies.has(roleId) && !has) { await member.roles.add(role, 'Bouncer: holder rule').catch(() => {}); added.push(role.name); }
    if (!qualifies.has(roleId) && has) { await member.roles.remove(role, 'Bouncer: holder rule').catch(() => {}); removed.push(role.name); }
  }
  return { added, removed };
}

async function syncAllHolders() {
  const guild = await client.guilds.fetch(cfg.guildId);
  let checked = 0;
  let changed = 0;
  for (const { userId } of store.allWallets()) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    const r = await syncHolder(member);
    checked += 1;
    if (r.added.length || r.removed.length) changed += 1;
    await new Promise((res) => setTimeout(res, 400)); // be gentle with public XRPL servers
  }
  return { checked, changed };
}

// ---------- slash commands ----------

const reply = (i, content, extra = {}) => (i.deferred || i.replied
  ? i.editReply({ content, ...extra })
  : i.reply({ content, flags: EPH, ...extra }));

async function cmdBouncer(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'status') {
    const up = Math.floor((Date.now() - startedAt) / 60_000);
    const gate = store.get('gate');
    return i.reply({
      flags: EPH,
      embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(raid.isActive() ? '🚨 Raid mode ON' : `🟢 ${line('calm')}`)
        .setDescription([
          `Up ${Math.floor(up / 60)}h ${up % 60}m`,
          `Removed **${stats.removed}** · Flagged **${stats.flagged}** · Secrets caught **${stats.secrets}** · Floods **${stats.floods}**`,
          `Timeouts **${stats.timeouts}** · Warns **${stats.warns}** · Door flags **${stats.joinsFlagged}** · Raids **${stats.raids}**`,
          `Gate: ${gate ? `on in <#${gate.channelId}> → <@&${gate.roleId}> (${stats.entered} entered)` : 'off'} · Welcome: ${store.get('welcomeChannelId') ? `<#${store.get('welcomeChannelId')}>` : 'off'}`,
          `Linked wallets **${store.allWallets().length}** · Holder rules **${store.rules().length}** · Xaman ${xaman.enabled ? 'ready' : 'not set up'}`,
          `Allowlist ${cfg.allowedDomains.length} · Blocklist ${cfg.blockedDomains.length} · Scam addresses ${cfg.blockedAddresses.length}`,
        ].join('\n')).setFooter({ text: 'Bouncer' })],
    });
  }

  if (sub === 'check') {
    const input = i.options.getString('link');
    const hosts = extractHosts(input.includes('.') && !input.startsWith('http') ? `https://${input}` : input);
    const out = hosts.length ? hosts.map((h) => `\`${h}\` → **${classifyHost(h, cfg)}**`).join('\n') : 'No domain found in that.';
    return reply(i, out);
  }

  if (sub === 'raid') {
    const on = i.options.getString('mode') === 'on';
    raid.set(on);
    await modlog({ content: `${on ? '🚨 Raid mode turned **on**' : '🟢 Raid mode turned **off**'} by ${i.user}.` });
    return reply(i, on ? line('raid') : line('calm'));
  }

  if (sub === 'domain') {
    const action = i.options.getString('action');
    const domain = cleanDomain(i.options.getString('domain'));
    if (!domain) return reply(i, "That doesn't look like a domain.");
    let msg;
    if (action === 'allow') {
      store.listRemove('blockedDomains', domain);
      msg = store.listAdd('allowedDomains', domain) ? `✅ \`${domain}\` allowed.` : `\`${domain}\` was already allowed.`;
    } else if (action === 'block') {
      store.listRemove('allowedDomains', domain);
      msg = store.listAdd('blockedDomains', domain) ? `⛔ \`${domain}\` blocked.` : `\`${domain}\` was already blocked.`;
    } else {
      const a = store.listRemove('allowedDomains', domain);
      const b = store.listRemove('blockedDomains', domain);
      msg = a || b ? `\`${domain}\` removed from the runtime lists.` : `\`${domain}\` isn't on the runtime lists.`;
      if (base.allowedDomains.includes(domain) || base.blockedDomains.includes(domain)) msg += ' It is also in config.json; edit the file to change that.';
    }
    refreshCfg();
    await modlog({ content: `🛠️ ${i.user} · domain **${action}** \`${domain}\`` });
    return reply(i, `${msg} Now classified as **${classifyHost(domain, cfg)}**.`);
  }

  if (sub === 'name') {
    const action = i.options.getString('action');
    const name = i.options.getString('name').trim().toLowerCase().slice(0, 64);
    if (name.length < 3) return reply(i, 'Names need at least 3 characters.');
    const ok = action === 'protect' ? store.listAdd('protectedNames', name) : store.listRemove('protectedNames', name);
    refreshCfg();
    if (ok) await modlog({ content: `🛠️ ${i.user} · name **${action}** \`${name}\`` });
    if (action === 'remove' && !ok && base.protectedNames.includes(name)) return reply(i, `\`${name}\` is in config.json; edit the file to remove it.`);
    return reply(i, ok ? `Done: \`${name}\` ${action === 'protect' ? 'is now protected' : 'removed'}.` : 'Nothing changed.');
  }

  if (sub === 'address') {
    const action = i.options.getString('action');
    const address = i.options.getString('address').trim();
    if (!isValidAddress(address)) return reply(i, "That isn't a valid XRPL r-address (checksum failed).");
    let ok;
    if (action === 'block') {
      ok = store.listAdd('blockedAddresses', address);
      store.noteAddress(address, i.options.getString('note')?.slice(0, 200) ?? null);
    } else {
      ok = store.listRemove('blockedAddresses', address);
      store.noteAddress(address, null);
    }
    refreshCfg();
    if (ok) await modlog({ content: `🛠️ ${i.user} · address **${action}** \`${address}\`` });
    return reply(i, ok ? `Done: \`${address}\` ${action === 'block' ? 'is now on the scam list. Messages containing it get removed.' : 'removed from the scam list.'}` : 'Nothing changed.');
  }

  if (sub === 'lists') {
    const fmt = (arr, max = 25) => (arr.length ? arr.slice(0, max).map((x) => `\`${x}\``).join(', ') + (arr.length > max ? ` …+${arr.length - max}` : '') : '—');
    const L = store.data.lists;
    return i.reply({
      flags: EPH,
      embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Runtime lists (added with commands)')
        .addFields(
          { name: 'Allowed domains', value: fmt(L.allowedDomains) },
          { name: 'Blocked domains', value: fmt(L.blockedDomains) },
          { name: 'Protected names', value: fmt(L.protectedNames) },
          { name: 'Scam addresses', value: fmt(L.blockedAddresses, 15) },
        )
        .setFooter({ text: `Plus config.json: ${base.allowedDomains.length} allowed · ${base.blockedDomains.length} blocked · ${base.protectedNames.length} names` })],
    });
  }

  if (sub === 'gate') {
    const channel = i.options.getChannel('channel');
    const role = i.options.getRole('role');
    if (!role.editable) return reply(i, `I can't give **${role.name}**. Drag Bouncer's role above it in Server Settings → Roles, then run this again.`);
    if (role.managed || role.id === i.guild.id) return reply(i, 'Pick a normal role (not @everyone or a bot role).');
    const panel = await channel.send({
      embeds: [new EmbedBuilder().setColor(COLORS.flag).setTitle('🚪 The door')
        .setDescription([
          'Press the button to enter the Club.',
          '',
          'House rules at the rope:',
          '• Staff will **never** DM you first.',
          '• Nobody here will ever ask for your seed, secret numbers or private key.',
          '• No "wallet verification" links. The only wallet sign-in is `/wallet link`, and it is never a payment.',
        ].join('\n'))
        .setFooter({ text: 'Bouncer' })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bouncer:gate').setLabel('Enter the Club').setEmoji('🍸').setStyle(ButtonStyle.Success),
      )],
    }).catch((e) => e);
    if (panel instanceof Error) return reply(i, `Couldn't post in ${channel}: ${panel.message}`);
    const old = store.get('gate');
    if (old?.messageId && old.channelId) client.channels.cache.get(old.channelId)?.messages?.delete(old.messageId).catch(() => {});
    store.set('gate', { channelId: channel.id, roleId: role.id, messageId: panel.id });
    await modlog({ content: `🛠️ ${i.user} turned the gate **on**: ${channel} → ${role}` });
    return reply(i, [
      `Gate is on. The button is in ${channel}; pressing it gives **${role.name}**.`,
      '',
      '**To finish (in Server Settings → Roles / channel permissions):**',
      `1. @everyone: can see ${channel} only. Turn off *Send Messages* everywhere else (or *View Channel* on the rest).`,
      `2. **${role.name}**: give it the access members have now (View Channels, Send Messages, etc.).`,
      `3. Give **${role.name}** to existing members so nobody gets locked out (Server Settings → Roles → ${role.name} → Manage Members, or a bulk role bot).`,
    ].join('\n'));
  }

  if (sub === 'gate-off') {
    const old = store.get('gate');
    if (!old) return reply(i, 'The gate is already off.');
    client.channels.cache.get(old.channelId)?.messages?.delete(old.messageId).catch(() => {});
    store.set('gate', null);
    await modlog({ content: `🛠️ ${i.user} turned the gate **off**.` });
    return reply(i, 'Gate is off and the button is removed. Remember to undo the @everyone permission changes if you made them.');
  }

  if (sub === 'welcome') {
    const channel = i.options.getChannel('channel');
    store.set('welcomeChannelId', channel?.id ?? null);
    return reply(i, channel ? `New members will be welcomed in ${channel}${store.get('gate') ? ' after they press the gate button' : ''}.` : 'Welcome messages are off.');
  }
  return null;
}

async function cmdWarn(i) {
  const user = i.options.getUser('member');
  const reason = i.options.getString('reason');
  const member = await i.guild.members.fetch(user.id).catch(() => null);
  if (user.bot) return reply(i, "Bots don't get strikes.");
  if (member && isStaff(member)) return reply(i, "That's staff. Talk to them directly.");
  stats.warns += 1;
  const s = await strike(member, user, 'warn', reason, i.user.id);
  const dm = await user.send(`⚠️ You received a warning in **${i.guild.name}**: ${reason}\nStrikes expire after ${base.strikes.expireDays} days.`).then(() => true).catch(() => false);
  await modlog({
    embeds: [baseEmbed('flag', user, '⚠️ Warning')
      .addFields({ name: 'Reason', value: reason }, { name: 'By', value: `${i.user}`, inline: true }, { name: 'DM', value: dm ? 'Sent' : 'DMs closed', inline: true }, strikeField(s))],
    components: s.escalated?.startsWith('Timed out') ? buttons(user.id, true) : [],
  });
  return reply(i, `Warned ${user}. ${strikeField(s).value.replace(/\*\*/g, '')}`);
}

async function cmdUnwarn(i) {
  const id = i.options.getInteger('case');
  const c = store.revokeCase(id);
  if (!c) return reply(i, `Case #${id} doesn't exist or is already revoked.`);
  await modlog({ content: `↩️ ${i.user} revoked case #${id} (<@${c.userId}>, ${c.type}: ${c.reason})` });
  return reply(i, `Case #${id} revoked. <@${c.userId}> now has ${store.strikeCount(c.userId, base.strikes.expireDays)} active strike(s).`);
}

async function cmdCases(i) {
  const user = i.options.getUser('member');
  const list = store.casesFor(user.id);
  const active = store.strikeCount(user.id, base.strikes.expireDays);
  const lines = list.slice(0, 15).map((c) => {
    const when = `<t:${Math.floor(c.at / 1000)}:d>`;
    const who = c.modId ? ` by <@${c.modId}>` : ' (auto)';
    const txt = `#${c.id} ${when} **${c.type}**${who}: ${c.reason.slice(0, 120)}`;
    return c.active ? txt : `~~${txt}~~`;
  });
  return i.reply({
    flags: EPH,
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`Cases · ${user.tag ?? user.username}`)
      .setDescription(lines.length ? lines.join('\n') : 'Clean record.')
      .setFooter({ text: `${active} active strike(s) · ${list.length} total` })],
  });
}

async function cmdWallet(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'show') {
    const w = store.walletOf(i.user.id);
    return reply(i, w ? `Linked: \`${w.address}\` since <t:${Math.floor(w.linkedAt / 1000)}:D>. [xrpscan](${xrpscan('account', w.address)})` : 'No wallet linked. Use `/wallet link`.');
  }

  if (sub === 'unlink') {
    const ok = store.unlinkWallet(i.user.id);
    if (ok && i.member) await syncHolder(i.member).catch(() => {});
    return reply(i, ok ? 'Wallet unlinked. Holder roles removed.' : 'No wallet was linked.');
  }

  // link
  if (!xaman.enabled) return reply(i, 'Wallet linking is not set up yet. Ask a mod.');
  if (linking.has(i.user.id)) return reply(i, 'You already have a sign-in request open. Finish or wait for it to expire (5 min).');
  linking.add(i.user.id);
  try {
    await i.deferReply({ flags: EPH });
    const identifier = `d${i.user.id}-${Date.now().toString(36)}`.slice(0, 40);
    const p = await xaman.createSignIn(identifier, `Sign in to link this wallet to ${i.guild.name} on Discord. This is not a payment.`);
    await i.editReply({
      embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('Link your wallet with Xaman')
        .setDescription([
          'Scan the QR with Xaman, or tap the button on your phone.',
          '',
          'This is a **Sign In** request only: no payment, no trustline, nothing leaves your wallet.',
          'If Xaman shows anything else, **reject it** and tell a mod.',
          '',
          'Expires in 5 minutes.',
        ].join('\n'))
        .setImage(p.qr)],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(p.link).setLabel('Open in Xaman'))],
    });
    const r = await xaman.waitForSignIn(p.uuid);
    if (!r.signed || !r.account || !isValidAddress(r.account) || (r.txType && r.txType !== 'SignIn')) {
      return i.editReply({ content: r.expired ? 'Request expired. Run `/wallet link` again.' : 'Not linked: the request was declined.', embeds: [], components: [] });
    }
    const movedFrom = store.linkWallet(i.user.id, r.account);
    const member = await i.guild.members.fetch(i.user.id).catch(() => null);
    const sync = member ? await syncHolder(member) : { added: [] };
    await i.editReply({
      content: `✅ Linked \`${r.account}\`.${sync.added.length ? ` Roles added: ${sync.added.join(', ')}.` : ''}`,
      embeds: [],
      components: [],
    });
    await modlog({
      embeds: [baseEmbed('ok', i.user, '🔗 Wallet linked')
        .addFields(
          { name: 'Address', value: `[\`${r.account}\`](${xrpscan('account', r.account)})` },
          ...(movedFrom ? [{ name: 'Note', value: `This wallet was linked to <@${movedFrom}> before. Moved to this member.` }] : []),
          ...(cfg.blockedAddresses.includes(r.account) ? [{ name: '⚠️', value: 'This address is on the scam list.' }] : []),
        )],
    });
    return null;
  } finally {
    linking.delete(i.user.id);
  }
}

async function cmdXrpl(i) {
  const sub = i.options.getSubcommand();
  await i.deferReply({ flags: EPH });

  if (sub === 'account') {
    const target = i.options.getUser('member');
    let address = i.options.getString('address')?.trim();
    if (!address && target) address = store.walletOf(target.id)?.address;
    if (!address) return i.editReply(target ? `${target} hasn't linked a wallet.` : 'Give me an r-address or a member.');
    if (!isValidAddress(address)) return i.editReply("That isn't a valid XRPL r-address (checksum failed).");
    const info = await xrpl.accountInfo(address);
    const e = new EmbedBuilder().setColor(COLORS.info).setTitle(short(address)).setURL(xrpscan('account', address)).setFooter({ text: 'Read-only · validated ledger' });
    if (cfg.blockedAddresses.includes(address)) {
      e.setColor(COLORS.remove).setDescription(`⛔ **On Bouncer's scam list.**${store.data.addressNotes[address] ? ` ${store.data.addressNotes[address]}` : ''}`);
    }
    if (!info) return i.editReply({ embeds: [e.addFields({ name: 'Status', value: 'Not activated (no XRP reserve yet).' })] });
    const [lines, nfts] = await Promise.all([xrpl.lines(address).catch(() => null), xrpl.nfts(address).catch(() => null)]);
    const topLines = (lines ?? []).filter((l) => Number(l.balance) > 0).sort((a, b) => Number(b.balance) - Number(a.balance)).slice(0, 5)
      .map((l) => `${Number(l.balance).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${currencyName(l.currency)}`);
    const linkedTo = store.userByWallet(address);
    e.addFields(
      { name: 'Balance', value: formatAmount(info.Balance), inline: true },
      { name: 'Objects owned', value: String(info.OwnerCount), inline: true },
      { name: 'Trustlines', value: lines ? String(lines.length) : '—', inline: true },
      { name: 'NFTs', value: nfts ? `${nfts.items.length}${nfts.more ? '+' : ''}` : '—', inline: true },
      { name: 'Domain', value: info.Domain ? `\`${hexToAscii(info.Domain).slice(0, 100)}\`` : '—', inline: true },
      { name: 'Linked member', value: linkedTo ? `<@${linkedTo}>` : '—', inline: true },
    );
    if (topLines.length) e.addFields({ name: 'Top holdings', value: topLines.join('\n') });
    return i.editReply({ embeds: [e] });
  }

  if (sub === 'tx') {
    const hash = i.options.getString('hash').trim().toUpperCase();
    if (!isTxHash(hash)) return i.editReply('A tx hash is 64 hex characters.');
    const tx = await xrpl.tx(hash);
    if (!tx) return i.editReply('Transaction not found.');
    const t = tx.tx_json ?? tx; // API v2 nests fields under tx_json
    const meta = tx.meta ?? {};
    const amount = meta.delivered_amount ?? t.DeliverMax ?? t.Amount;
    const flagged = [t.Account, t.Destination].filter((a) => a && cfg.blockedAddresses.includes(a));
    const e = new EmbedBuilder().setColor(flagged.length ? COLORS.remove : COLORS.info)
      .setTitle(`${t.TransactionType} · ${meta.TransactionResult ?? 'pending'}`)
      .setURL(xrpscan('tx', hash))
      .addFields(
        { name: 'From', value: t.Account ? `\`${t.Account}\`` : '—' },
        ...(t.Destination ? [{ name: 'To', value: `\`${t.Destination}\`${t.DestinationTag != null ? ` · tag ${t.DestinationTag}` : ''}` }] : []),
        ...(amount ? [{ name: meta.delivered_amount ? 'Delivered' : 'Amount', value: formatAmount(amount), inline: true }] : []),
        { name: 'Fee', value: formatAmount(t.Fee), inline: true },
        { name: 'Validated', value: tx.validated ? 'Yes' : 'Not yet', inline: true },
      )
      .setFooter({ text: 'Read-only' });
    const date = tx.date ?? t.date;
    if (date) e.setTimestamp(rippleTime(date));
    if (flagged.length) e.setDescription(`⛔ Involves an address on Bouncer's scam list: ${flagged.map((a) => `\`${a}\``).join(', ')}`);
    return i.editReply({ embeds: [e] });
  }

  if (sub === 'domain') {
    const domain = cleanDomain(i.options.getString('domain'));
    if (!domain) return i.editReply("That doesn't look like a public domain.");
    const kind = classifyHost(domain, cfg);
    const verdict = {
      allowed: '✅ On the allowlist',
      blocked: '⛔ Blocked',
      punycode: '⛔ Punycode (lookalike characters)',
      lookalike: '⛔ Lookalike of a protected brand',
      shortener: '⚠️ Link shortener (hides the real site)',
      suspicious: '⚠️ Uses a protected brand name on another domain',
      unknown: '❔ Unknown to Bouncer',
    }[kind];
    const toml = await fetchLedgerToml(domain);
    const checks = await Promise.all(toml.accounts.map(async (a) => {
      const info = await xrpl.accountInfo(a).catch(() => null);
      const d = info?.Domain ? hexToAscii(info.Domain).toLowerCase() : '';
      const twoWay = d === domain || d.endsWith(`.${domain}`) || domain.endsWith(`.${d}`);
      return `\`${a}\` ${twoWay ? '✅ points back to this domain' : '⚠️ does not point back'}`;
    }));
    const e = new EmbedBuilder().setColor(kind === 'allowed' ? COLORS.ok : ['unknown'].includes(kind) ? COLORS.info : COLORS.remove)
      .setTitle(domain)
      .addFields(
        { name: "Bouncer's verdict", value: verdict },
        { name: 'xrp-ledger.toml', value: toml.found ? (checks.length ? checks.join('\n').slice(0, 1000) : 'Found, but lists no accounts.') : 'Not found.' },
      )
      .setFooter({ text: 'A two-way match (toml lists the account, the account lists the domain) is how XRPL projects prove who they are.' });
    return i.editReply({ embeds: [e] });
  }
  return null;
}

async function cmdHolder(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'list') {
    const rules = store.rules();
    return reply(i, rules.length
      ? rules.map((r) => `**#${r.id}** <@&${r.roleId}> ← ${describeRule(r)}`).join('\n')
      : 'No holder rules yet. Add one with `/holder add`.', { allowedMentions: { parse: [] } });
  }

  if (sub === 'remove') {
    const r = store.removeRule(i.options.getInteger('rule'));
    if (!r) return reply(i, 'No rule with that number.');
    await modlog({ content: `🛠️ ${i.user} removed holder rule #${r.id} (<@&${r.roleId}> ← ${describeRule(r)})`, allowedMentions: { parse: [] } });
    return reply(i, `Rule #${r.id} removed. Run \`/holder sync\` to take the role off people who only had it from this rule.`);
  }

  if (sub === 'sync') {
    await i.deferReply({ flags: EPH });
    const { checked, changed } = await syncAllHolders();
    return i.editReply(`Checked ${checked} linked wallet(s). ${changed} member(s) had roles updated.`);
  }

  // add
  const role = i.options.getRole('role');
  const type = i.options.getString('type');
  const issuer = i.options.getString('issuer')?.trim() ?? null;
  const currency = i.options.getString('currency')?.trim() ?? null;
  const taxon = i.options.getInteger('taxon');
  let min = i.options.getNumber('min');
  if (!role.editable) return reply(i, `I can't give **${role.name}**. Drag Bouncer's role above it first.`);
  if (role.managed || role.id === i.guild.id) return reply(i, 'Pick a normal role.');
  if (type !== 'xrp' && (!issuer || !isValidAddress(issuer))) return reply(i, 'Token and NFT rules need a valid issuer r-address.');
  if (type === 'trustline' && !currency) return reply(i, 'Token rules need a currency code, e.g. `TERRY`.');
  if (type === 'trustline' && currency.length > 20 && !/^[A-F0-9]{40}$/i.test(currency)) return reply(i, 'Currency codes are up to 20 characters (or 40-char hex).');
  if (type === 'xrp' && !(min > 0)) return reply(i, 'XRP rules need a minimum above 0.');
  min ??= type === 'nft' ? 1 : 0;
  const rule = store.addRule({
    roleId: role.id, type, min,
    ...(type !== 'xrp' ? { issuer } : {}),
    ...(type === 'trustline' ? { currency } : {}),
    ...(type === 'nft' && taxon != null ? { taxon } : {}),
  });
  await modlog({ content: `🛠️ ${i.user} added holder rule #${rule.id}: ${role} ← ${describeRule(rule)}`, allowedMentions: { parse: [] } });
  return reply(i, `Rule #${rule.id}: **${role.name}** ← ${describeRule(rule)}. Linked wallets are checked on link and every ${base.xrpl.holderSyncHours}h; run \`/holder sync\` to apply it now.`);
}

// ---------- buttons ----------

async function gateButton(i) {
  const gate = store.get('gate');
  if (!gate) return reply(i, 'The door is open. No gate right now.');
  const member = await i.guild.members.fetch(i.user.id).catch(() => null);
  if (!member) return reply(i, 'Something went wrong. Try again.');
  if (member.roles.cache.has(gate.roleId)) return reply(i, "You're already inside. 🍸");
  const secs = (Date.now() - member.joinedTimestamp) / 1000;
  const wait = Math.ceil(base.gate.minSecondsAfterJoin - secs);
  if (wait > 0) return reply(i, `Take a look at the rules first. Press again in ${wait}s.`);
  if (raid.isActive() && ageDays(i.user) < cfg.minAccountAgeDays) return reply(i, 'The door is on hold while we deal with a crowd. Try again in a few minutes.');
  if (member.isCommunicationDisabled()) return reply(i, "You're timed out right now. Try again after it ends.");
  try {
    await member.roles.add(gate.roleId, 'Bouncer: entered through the gate');
  } catch (e) {
    await modlog({ content: `⚠️ Gate failed for ${i.user}: ${e.message}. Check Bouncer's role is above the gate role.` });
    return reply(i, "I couldn't open the door. A mod has been told.");
  }
  stats.entered += 1;
  await welcome(member);
  return reply(i, "You're in. Welcome to the Club. 🍸");
}

async function modButton(i) {
  const [, action, userId] = i.customId.split(':');
  // Anyone who can run /bouncer can mark a log handled; timeouts need Timeout Members.
  const needed = action === 'handled' ? PermissionFlagsBits.ManageMessages : PermissionFlagsBits.ModerateMembers;
  if (!i.memberPermissions?.has(needed)) {
    return i.reply({ flags: EPH, content: action === 'handled' ? 'Staff only.' : 'You need the Timeout Members permission for that.' });
  }
  let result = `Marked handled by ${i.user}`;
  if (action === 'timeout' || action === 'untimeout') {
    const member = await i.guild.members.fetch(userId).catch(() => null);
    if (!member) result = 'Member already left.';
    else if (action === 'timeout') result = `${await timeout(member, `manual, by ${i.user.tag}`)} by ${i.user}`;
    else {
      await member.timeout(null, `Bouncer: lifted by ${i.user.tag}`).catch(() => {});
      result = `Timeout lifted by ${i.user}`;
    }
  }
  const embed = i.message.embeds[0] ? EmbedBuilder.from(i.message.embeds[0]).addFields({ name: 'Mod', value: result }) : null;
  const done = action === 'handled' || action === 'untimeout';
  return i.update({ ...(embed ? { embeds: [embed] } : { content: `${i.message.content}\n${result}` }), components: done ? [] : buttons(userId, true) });
}

const HANDLERS = { bouncer: cmdBouncer, warn: cmdWarn, unwarn: cmdUnwarn, cases: cmdCases, wallet: cmdWallet, xrpl: cmdXrpl, holder: cmdHolder };

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.guildId && i.guildId !== cfg.guildId) return;
    if (i.isChatInputCommand() && HANDLERS[i.commandName]) return await HANDLERS[i.commandName](i);
    if (i.isButton() && i.customId === 'bouncer:gate') return await gateButton(i);
    if (i.isButton() && i.customId.startsWith('bouncer:')) return await modButton(i);
  } catch (err) {
    console.error('interaction:', err);
    const msg = /XRPL|HTTP|fetch|timeout|abort/i.test(err.message) ? 'The XRPL servers are slow right now. Try again in a minute.' : 'Something went wrong. Check the logs.';
    if (i.isRepliable()) await reply(i, msg).catch(() => {});
  }
  return null;
});

// ---------- boot ----------

client.once(Events.ClientReady, async (c) => {
  console.log(`Bouncer on the door as ${c.user.tag}`);
  const guild = await c.guilds.fetch(cfg.guildId).catch(() => null);
  if (!guild) {
    console.error(`Not in guild ${cfg.guildId}. Invite Bouncer first.`);
    return;
  }
  await guild.commands.set(commands);
  await guild.roles.fetch();
  await refreshStaffNames(guild);
  setInterval(() => refreshStaffNames(guild), 30 * 60_000);
  setInterval(() => flood.sweep(), 5 * 60_000);
  if (store.rules().length) setTimeout(() => syncAllHolders().catch((e) => console.error('holder sync:', e.message)), 60_000);
  setInterval(() => syncAllHolders().catch((e) => console.error('holder sync:', e.message)), base.xrpl.holderSyncHours * 3_600_000);
  if (!xaman.enabled) console.log('Xaman keys not set: /wallet link is off. Add XAMAN_API_KEY and XAMAN_API_SECRET to .env to turn it on.');
  c.user.setActivity('the door', { type: 3 }); // "Watching the door"
});

process.on('unhandledRejection', (e) => console.error('unhandled:', e));
client.login(TOKEN);
