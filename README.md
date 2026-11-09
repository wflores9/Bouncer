# 🚪 Bouncer

Door security for **The Trustline Club** Discord. Bouncer watches the rope: it removes clear scams, times out the people posting them, and flags everything else for a human. It also runs the door (a gate button), keeps a strike record, links XRPL wallets through Xaman and hands out holder roles.

> Same ledger. Higher standards.

## What it does

| Situation | Bouncer's move |
|---|---|
| Asks for a seed / private key, "double your XRP", send-to-receive, sign-to-claim | **Delete + timeout + log** |
| Lookalike / punycode / blocked domain (`xaman.io`, `trustline-terrry.xyz`, `xn--…`) | **Delete + timeout + log** |
| Disguised link (`[xaman.app](https://evil.top)`) | **Delete + timeout + log** |
| Discord invite from a non-staff member | **Delete + timeout + log** |
| Mass mention (5+ by default) | **Delete + timeout + log** |
| "Verify your wallet" / "claim airdrop" bait **with** a link | **Delete + timeout + log** |
| Same bait with no link | Flag in #modlog |
| Unknown link or shortener | Flag (delete + timeout if the account is under 7 days old) |
| Someone posts a real **family seed, Xaman secret numbers or 12/24-word phrase** | Delete, warn them by DM, **no timeout** (they're the victim), log redacted |
| Name copies staff or a protected name (`Trustline Terry`, `ꜱᴜᴘᴘᴏʀᴛ`, `wfIores`); checked on join, nickname and username changes | Exact: timeout + log. Close: flag |
| Fresh account (< 7 days) joins | Flag |
| 8+ joins in 60s | **Raid mode** for 10 min: new accounts get timed out on join |
| Message contains an address on the **scam address list** | **Delete + timeout + log** |
| Bait ("claim your airdrop") plus any r-address to send to | **Delete + timeout + log** |
| 7+ messages in 10s, or the same message 3x / in 3 channels (2 if it has a link) | **Delete all copies + timeout + log** |
| Ticket Tool opens a `report-` channel | Pings #staff |

**Bans stay manual.** Every log has **Timeout / Lift timeout / Handled** buttons for mods.
Staff (anyone with *Manage Messages*) and bots are exempt. Edited messages are re-checked.

### Strikes

Every automatic removal and every `/warn` is a **strike** with a case number. Strikes expire after 30 days.
2 strikes → 6h timeout, 3 → 24h timeout and the log says *consider a ban*. All tunable under `strikes` in config.

### Slash commands

**Mods (Manage Messages)**

- `/bouncer status`: counters, uptime, raid, gate, wallets
- `/bouncer check link:<url>`: how Bouncer would classify a link
- `/bouncer raid mode:on|off`: manual raid mode
- `/bouncer domain action:allow|block|remove domain:` · `/bouncer name action:protect|remove name:` · `/bouncer address action:block|remove address: note:`: change the lists live, no restart
- `/bouncer lists`: what's been added with commands
- `/bouncer gate channel: role:` / `/bouncer gate-off`: the "Enter the Club" button
- `/bouncer welcome channel:`: where new members get welcomed (empty = off)
- `/cases member:`: case history

**Mods (Timeout Members)**: `/warn member: reason:` · `/unwarn case:`

**Mods (Manage Roles)**: `/holder add role: type:trustline|nft|xrp issuer: currency: min: taxon:` · `/holder list` · `/holder remove rule:` · `/holder sync`

**Everyone** (replies are private)

- `/wallet link` · `/wallet show` · `/wallet unlink`: link a wallet by signing in with Xaman. It is a **SignIn request only**: it can't move funds or set a trustline.
- `/xrpl account address:|member:` · `/xrpl tx hash:` · `/xrpl domain domain:`: read-only lookups. `domain` also checks the site's `xrp-ledger.toml` and whether its accounts point back to it.

Default permissions can be changed per role in Server Settings → Integrations → Bouncer.

## Setup

1. **Create the app.** [Discord Developer Portal](https://discord.com/developers/applications) → New Application → name it **Bouncer** → Bot tab:
   - Reset Token → copy it
   - Turn on **Server Members Intent** and **Message Content Intent**
2. **Invite it** (replace `APP_ID`):
   ```
   https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=1099780156416
   ```
   That's View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Timeout Members and Manage Roles (for the gate and holder roles). Nothing else.
   Already invited with v1.0? Either use the new link, or give the Bouncer role **Manage Roles** in Server Settings → Roles.
3. **Role order.** Server Settings → Roles: drag **Bouncer** above the member roles *and* above any gate / holder roles (below Admin/Moderator), or timeouts and role changes will fail.
4. **Run it**
   ```bash
   cp .env.example .env   # paste the token
   npm install
   npm test               # detection tests
   npm start
   ```
   Node 20+. Any always-on host works (Railway, Fly.io, a VPS, a Pi).
5. **Optional: Xaman wallet linking.** Create an app at [apps.xumm.dev](https://apps.xumm.dev), copy the API key and secret into `.env` as `XAMAN_API_KEY` / `XAMAN_API_SECRET`, restart. Without them, `/wallet link` politely says it's off.

### Turning on the gate

1. Create a role, e.g. **Patron**, and drag Bouncer above it.
2. `/bouncer gate channel:#welcome role:@Patron` posts the button.
3. Give **@Patron** existing members (so nobody is locked out), then lock @everyone down to the welcome channel and give @Patron the normal access.
4. Optional: `/bouncer welcome channel:#lounge` so people get a hello once they're in.

New members wait 15s before the button works (`gate.minSecondsAfterJoin`), and during raid mode fresh accounts are held back.

## Data

Strikes, linked wallets, runtime lists, holder rules and gate settings live in `data/bouncer.json` (git-ignored). Back it up if you move hosts.

## Config (`config.json`)

| Key | What |
|---|---|
| `guildId`, `modlogChannelId`, `staffChannelId` | Pre-filled for The Trustline Club |
| `allowedDomains` | Links that never trigger anything (subdomains included) |
| `protectedBrands` | Names a lookalike domain would copy |
| `blockedDomains` | Always delete + timeout |
| `protectedNames` | Names nobody but staff should wear (staff names are added automatically) |
| `minAccountAgeDays`, `timeoutMinutes`, `massMentionLimit` | Thresholds |
| `raid` | `joins` in `windowSeconds` → raid mode for `durationMinutes` |
| `exemptRoleIds` | Extra roles Bouncer ignores (e.g. trusted builders) |
| `blockedAddresses` | Scam r-addresses (also addable with `/bouncer address`) |
| `flood` | Messages per window, duplicate window / count, cross-channel limit |
| `strikes` | `expireDays` and escalation `steps` (`at` strikes → `timeoutMinutes`) |
| `gate.minSecondsAfterJoin` | How long new members wait before the button works |
| `xrpl.rpc`, `xrpl.holderSyncHours` | Public XRPL servers to use, and how often holder roles are re-checked |
| `dataFile` | Where Bouncer keeps its data |

Restart after editing. Test changes in a sandbox server first.

## Layout

```
src/index.js      Discord wiring: events, actions, logs, commands, buttons
src/commands.js   Slash command definitions
src/detect.js     Pure detection (no Discord calls)
src/normalize.js  Small caps, homoglyphs, leetspeak, edit distance
src/flood.js      Flood / copy-paste spam window
src/strikes.js    Strike escalation
src/raid.js       Join-rate window
src/store.js      JSON data file (cases, wallets, lists, rules, settings)
src/config.js     Config defaults + runtime list merge
src/xrpl.js       Read-only XRPL JSON-RPC, address checksum, toml check
src/xaman.js      Xaman SignIn requests
src/holders.js    Holder-role rules
src/voice.js      Bouncer's lines
test/             node:test suite
```
