import 'dotenv/config';
import { readFileSync } from 'node:fs';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder,
  Events, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { scanMessage, checkName, classifyHost, extractHosts } from './detect.js';
import { RaidWatch } from './raid.js';
import { line } from './voice.js';

const cfg = JSON.parse(readFileSync(process.env.BOUNCER_CONFIG ?? new URL('../config.json', import.meta.url), 'utf8'));
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const COLORS = { remove: 0xc0392b, secret: 0x8e44ad, flag: 0xc8a94a, info: 0x2c6fbb, raid: 0xe67e22 };
const DAY = 86_400_000;
const startedAt = Date.now();
const stats = { removed: 0, flagged: 0, secrets: 0, timeouts: 0, joinsFlagged: 0, raids: 0 };
const raid = new RaidWatch(cfg.raid);
let staffNames = [];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- helpers ----------

function isStaff(member) {
  if (!member) return false;
  if (member.user?.bot) return true;
  if (member.permissions?.has(PermissionFlagsBits.ManageMessages)) return true;
  return cfg.exemptRoleIds.some((id) => member.roles?.cache?.has(id));
}

function ageDays(user) {
  return (Date.now() - user.createdTimestamp) / DAY;
}

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

async function timeout(member, reason) {
  try {
    await member.timeout(cfg.timeoutMinutes * 60_000, `Bouncer: ${reason}`.slice(0, 500));
    stats.timeouts += 1;
    return `Timed out ${cfg.timeoutMinutes} min`;
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
    row.addComponents(new ButtonBuilder().setCustomId(`bouncer:timeout:${userId}`).setLabel(`Timeout ${cfg.timeoutMinutes}m`).setStyle(ButtonStyle.Danger));
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

// ---------- message screening ----------

async function screen(message) {
  if (!message.guild || message.guild.id !== cfg.guildId) return;
  if (message.author?.bot || message.system) return;
  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (isStaff(member)) return;

  const result = scanMessage({
    content: message.content,
    mentionCount: message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 99 : 0),
    accountAgeDays: ageDays(message.author),
  }, cfg);
  if (result.verdict === 'none') return;

  const where = `${message.channel} · [jump](${message.url})`;
  const user = message.author;

  if (result.verdict === 'secret') {
    stats.secrets += 1;
    await message.delete().catch(() => {});
    const warn = `${line('secret')} Your message was removed. If that was a real wallet secret, treat the wallet as compromised and move funds to a new one now.`;
    const dm = await user.send(warn).then(() => true).catch(() => false);
    if (!dm) await notice(message.channel, `${user} ${warn}`, 30);
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
    await notice(message.channel, `${line('remove')} (${user})`);
    await modlog({
      embeds: [baseEmbed('remove', user, `🚪 ${line('remove')}`)
        .addFields(
          { name: 'Where', value: where },
          { name: 'Why', value: result.reasons.join('\n').slice(0, 1000) },
          { name: 'Action', value: `Deleted. ${t}` },
          { name: 'Account age', value: `${ageDays(user).toFixed(1)} days`, inline: true },
          { name: 'Message', value: excerpt(message.content) },
        )],
      components: buttons(user.id, t.startsWith('Timed out')),
    });
    return;
  }

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

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== cfg.guildId || member.user.bot) return;
  const age = ageDays(member.user);

  if (raid.record()) {
    stats.raids += 1;
    await modlog({
      embeds: [new EmbedBuilder().setColor(COLORS.raid).setTitle(`🚨 ${line('raid')}`)
        .setDescription(`${cfg.raid.joins}+ joins in ${cfg.raid.windowSeconds}s. Raid mode is on for ${cfg.raid.durationMinutes} min.${cfg.raid.timeoutNewAccounts ? ` New accounts (< ${cfg.minAccountAgeDays}d) are timed out on join.` : ''}\nTurn it off early with \`/bouncer raid off\`.`)
        .setFooter({ text: 'Bouncer' }).setTimestamp()],
    });
  }

  if (raid.isActive() && cfg.raid.timeoutNewAccounts && age < cfg.minAccountAgeDays) {
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
});

client.on(Events.GuildMemberUpdate, async (before, after) => {
  if (after.guild.id !== cfg.guildId) return;
  if (before.nickname !== after.nickname || before.user?.globalName !== after.user.globalName) {
    await checkMemberName(after, 'name change');
  }
});

// ---------- messages ----------

client.on(Events.MessageCreate, (m) => screen(m).catch((e) => console.error('screen:', e)));
client.on(Events.MessageUpdate, async (before, after) => {
  try {
    if (after.partial) after = await after.fetch();
    if (before.content === after.content) return; // embed unfurl, not an edit
    await screen(after);
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

// ---------- slash commands + buttons ----------

const command = new SlashCommandBuilder()
  .setName('bouncer')
  .setDescription('Door security controls')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((s) => s.setName('status').setDescription('How the door is doing'))
  .addSubcommand((s) => s.setName('check').setDescription('Check a link against the list')
    .addStringOption((o) => o.setName('link').setDescription('URL or domain').setRequired(true)))
  .addSubcommand((s) => s.setName('raid').setDescription('Turn raid mode on or off')
    .addStringOption((o) => o.setName('mode').setDescription('on or off').setRequired(true)
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })));

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'bouncer') {
      const sub = i.options.getSubcommand();
      if (sub === 'status') {
        const up = Math.floor((Date.now() - startedAt) / 60_000);
        return i.reply({
          ephemeral: true,
          embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(raid.isActive() ? '🚨 Raid mode ON' : `🟢 ${line('calm')}`)
            .setDescription([
              `Up ${Math.floor(up / 60)}h ${up % 60}m`,
              `Removed **${stats.removed}** · Flagged **${stats.flagged}** · Secrets caught **${stats.secrets}**`,
              `Timeouts **${stats.timeouts}** · Door flags **${stats.joinsFlagged}** · Raids **${stats.raids}**`,
              `Allowlist: ${cfg.allowedDomains.length} domains · Min account age ${cfg.minAccountAgeDays}d`,
            ].join('\n')).setFooter({ text: 'Bouncer' })],
        });
      }
      if (sub === 'check') {
        const input = i.options.getString('link');
        const hosts = extractHosts(input.includes('.') && !input.startsWith('http') ? `https://${input}` : input);
        const out = hosts.length ? hosts.map((h) => `\`${h}\` → **${classifyHost(h, cfg)}**`).join('\n') : 'No domain found in that.';
        return i.reply({ ephemeral: true, content: out });
      }
      if (sub === 'raid') {
        const on = i.options.getString('mode') === 'on';
        raid.set(on);
        await modlog({ content: `${on ? '🚨 Raid mode turned **on**' : '🟢 Raid mode turned **off**'} by ${i.user}.` });
        return i.reply({ ephemeral: true, content: on ? line('raid') : line('calm') });
      }
    }

    if (i.isButton() && i.customId.startsWith('bouncer:')) {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
        return i.reply({ ephemeral: true, content: 'Staff only.' });
      }
      const [, action, userId] = i.customId.split(':');
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
      const embed = EmbedBuilder.from(i.message.embeds[0]).addFields({ name: 'Mod', value: result });
      const done = action === 'handled' || action === 'untimeout';
      return i.update({ embeds: [embed], components: done ? [] : buttons(userId, true) });
    }
  } catch (err) {
    console.error('interaction:', err);
    if (i.isRepliable() && !i.replied) i.reply({ ephemeral: true, content: 'Something went wrong. Check the logs.' }).catch(() => {});
  }
});

// ---------- boot ----------

client.once(Events.ClientReady, async (c) => {
  console.log(`Bouncer on the door as ${c.user.tag}`);
  const guild = await c.guilds.fetch(cfg.guildId).catch(() => null);
  if (!guild) {
    console.error(`Not in guild ${cfg.guildId}. Invite Bouncer first.`);
    return;
  }
  await guild.commands.set([command.toJSON()]);
  await refreshStaffNames(guild);
  setInterval(() => refreshStaffNames(guild), 30 * 60_000);
  c.user.setActivity('the door', { type: 3 }); // "Watching the door"
});

process.on('unhandledRejection', (e) => console.error('unhandled:', e));
client.login(TOKEN);
