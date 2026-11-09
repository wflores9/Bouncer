// Slash command definitions. Default permissions are enforced by Discord;
// server admins can fine-tune them under Server Settings → Integrations → Bouncer.
import { ChannelType, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';

const bouncer = new SlashCommandBuilder()
  .setName('bouncer')
  .setDescription('Door security controls')
  .setDefaultMemberPermissions(P.ManageMessages)
  .addSubcommand((s) => s.setName('status').setDescription('How the door is doing'))
  .addSubcommand((s) => s.setName('check').setDescription('Check a link against the list')
    .addStringOption((o) => o.setName('link').setDescription('URL or domain').setRequired(true)))
  .addSubcommand((s) => s.setName('raid').setDescription('Turn raid mode on or off')
    .addStringOption((o) => o.setName('mode').setDescription('on or off').setRequired(true)
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
  .addSubcommand((s) => s.setName('domain').setDescription('Allow, block or un-list a domain (no restart needed)')
    .addStringOption((o) => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices({ name: 'allow', value: 'allow' }, { name: 'block', value: 'block' }, { name: 'remove', value: 'remove' }))
    .addStringOption((o) => o.setName('domain').setDescription('e.g. xrp.cafe').setRequired(true)))
  .addSubcommand((s) => s.setName('name').setDescription('Protect a name from impersonation, or remove one')
    .addStringOption((o) => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices({ name: 'protect', value: 'protect' }, { name: 'remove', value: 'remove' }))
    .addStringOption((o) => o.setName('name').setDescription('Name to protect').setRequired(true)))
  .addSubcommand((s) => s.setName('address').setDescription('Add or remove a scam r-address')
    .addStringOption((o) => o.setName('action').setDescription('What to do').setRequired(true)
      .addChoices({ name: 'block', value: 'block' }, { name: 'remove', value: 'remove' }))
    .addStringOption((o) => o.setName('address').setDescription('r-address').setRequired(true))
    .addStringOption((o) => o.setName('note').setDescription('Where it came from (optional)')))
  .addSubcommand((s) => s.setName('lists').setDescription('Show what mods have added at runtime'))
  .addSubcommand((s) => s.setName('gate').setDescription('Post the "Enter the Club" button and turn the gate on')
    .addChannelOption((o) => o.setName('channel').setDescription('Where the button goes (e.g. #welcome)').setRequired(true)
      .addChannelTypes(ChannelType.GuildText))
    .addRoleOption((o) => o.setName('role').setDescription('Role members get when they enter').setRequired(true))
    .addStringOption((o) => o.setName('mode').setDescription('What it takes to get in (default: button)')
      .addChoices(
        { name: 'button: just press it', value: 'button' },
        { name: 'wallet: Xaman sign-in, activated wallet', value: 'wallet' },
        { name: 'trustline: wallet + trustline to a token', value: 'trustline' },
      ))
    .addStringOption((o) => o.setName('issuer').setDescription('Token issuer r-address (trustline mode)'))
    .addStringOption((o) => o.setName('currency').setDescription('Token code, e.g. TERRY (trustline mode)')))
  .addSubcommand((s) => s.setName('gate-off').setDescription('Turn the gate off'))
  .addSubcommand((s) => s.setName('welcome').setDescription('Where Bouncer welcomes new members (leave empty to turn off)')
    .addChannelOption((o) => o.setName('channel').setDescription('e.g. #lounge').addChannelTypes(ChannelType.GuildText)));

const warn = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Give a member a strike')
  .setDefaultMemberPermissions(P.ModerateMembers)
  .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Why (they will see this)').setRequired(true).setMaxLength(300));

const unwarn = new SlashCommandBuilder()
  .setName('unwarn')
  .setDescription('Revoke a case by number')
  .setDefaultMemberPermissions(P.ModerateMembers)
  .addIntegerOption((o) => o.setName('case').setDescription('Case number').setRequired(true).setMinValue(1));

const cases = new SlashCommandBuilder()
  .setName('cases')
  .setDescription("A member's case history")
  .setDefaultMemberPermissions(P.ManageMessages)
  .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true));

const wallet = new SlashCommandBuilder()
  .setName('wallet')
  .setDescription('Link your XRPL wallet with Xaman')
  .addSubcommand((s) => s.setName('link').setDescription('Sign in with Xaman to link your wallet (no payment)'))
  .addSubcommand((s) => s.setName('unlink').setDescription('Unlink your wallet'))
  .addSubcommand((s) => s.setName('show').setDescription('Show your linked wallet'));

const xrpl = new SlashCommandBuilder()
  .setName('xrpl')
  .setDescription('Read-only XRPL lookups')
  .addSubcommand((s) => s.setName('account').setDescription('Look up an r-address (or a member\'s linked wallet)')
    .addStringOption((o) => o.setName('address').setDescription('r-address'))
    .addUserOption((o) => o.setName('member').setDescription('Member with a linked wallet')))
  .addSubcommand((s) => s.setName('tx').setDescription('Look up a transaction')
    .addStringOption((o) => o.setName('hash').setDescription('64-character tx hash').setRequired(true)))
  .addSubcommand((s) => s.setName('domain').setDescription('Check a domain: Bouncer\'s verdict + xrp-ledger.toml')
    .addStringOption((o) => o.setName('domain').setDescription('e.g. xaman.app').setRequired(true)));

const holder = new SlashCommandBuilder()
  .setName('holder')
  .setDescription('Holder roles for linked wallets')
  .setDefaultMemberPermissions(P.ManageRoles)
  .addSubcommand((s) => s.setName('add').setDescription('Give a role to wallets that hold something')
    .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true))
    .addStringOption((o) => o.setName('type').setDescription('What they must hold').setRequired(true)
      .addChoices({ name: 'trustline / token', value: 'trustline' }, { name: 'NFT', value: 'nft' }, { name: 'XRP balance', value: 'xrp' }))
    .addStringOption((o) => o.setName('issuer').setDescription('Issuer r-address (token or NFT)'))
    .addStringOption((o) => o.setName('currency').setDescription('Token code, e.g. TERRY (trustline only)'))
    .addNumberOption((o) => o.setName('min').setDescription('Minimum amount (trustline 0 = just the line; NFT default 1)').setMinValue(0))
    .addIntegerOption((o) => o.setName('taxon').setDescription('NFT taxon / collection (optional)').setMinValue(0)))
  .addSubcommand((s) => s.setName('remove').setDescription('Remove a holder rule')
    .addIntegerOption((o) => o.setName('rule').setDescription('Rule number from /holder list').setRequired(true).setMinValue(1)))
  .addSubcommand((s) => s.setName('list').setDescription('Show holder rules'))
  .addSubcommand((s) => s.setName('sync').setDescription('Re-check every linked wallet now'));

export const commands = [bouncer, warn, unwarn, cases, wallet, xrpl, holder].map((c) => c.toJSON());
