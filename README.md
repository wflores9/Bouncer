# 🚪 Bouncer

Door security for **The Trustline Club** Discord. Bouncer watches the rope: it removes clear scams, times out the people posting them, and flags everything else for a human.

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
| Ticket Tool opens a `report-` channel | Pings #staff |

**Bans stay manual.** Every log has **Timeout / Lift timeout / Handled** buttons for mods.
Staff (anyone with *Manage Messages*) and bots are exempt. Edited messages are re-checked.

### Slash commands (Manage Messages only)

- `/bouncer status`: counters, uptime, raid state
- `/bouncer check link:<url>`: how Bouncer would classify a link
- `/bouncer raid mode:on|off`: manual raid mode

## Setup

1. **Create the app.** [Discord Developer Portal](https://discord.com/developers/applications) → New Application → name it **Bouncer** → Bot tab:
   - Reset Token → copy it
   - Turn on **Server Members Intent** and **Message Content Intent**
2. **Invite it** (replace `APP_ID`):
   ```
   https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=1099511720960
   ```
   That's View Channels, Send Messages, Embed Links, Read Message History, Manage Messages and Timeout Members. Nothing else.
3. **Role order.** Server Settings → Roles: drag **Bouncer** above the member roles (below Admin/Moderator), or timeouts will fail.
4. **Run it**
   ```bash
   cp .env.example .env   # paste the token
   npm install
   npm test               # detection tests
   npm start
   ```
   Node 20+. Any always-on host works (Railway, Fly.io, a VPS, a Pi).

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

Restart after editing. Test changes in a sandbox server first.

## Layout

```
src/index.js      Discord wiring: events, actions, logs, commands, buttons
src/detect.js     Pure detection (no Discord calls)
src/normalize.js  Small caps, homoglyphs, leetspeak, edit distance
src/raid.js       Join-rate window
src/voice.js      Bouncer's lines
test/             node:test suite for detection
```
