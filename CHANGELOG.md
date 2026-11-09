# Changelog

## 1.3.0

- **Appeals:** every timeout DMs a one-time Appeal button; the member's side goes to #staff with Lift timeout / Handled buttons. One DM per removal, even when a strike escalates it.
- **Scam lookup alerts:** a member looking up a scam-listed address or tx with `/xrpl` triggers a #modlog heads-up.
- **Fix:** a bad token or missing intents now exits with an error, so Railway shows a crash and restarts instead of a quiet "Completed", with a hint in the log.


## 1.2.0

- **Gate modes:** `button`, `wallet` (Xaman sign-in + activated mainnet wallet) and `trustline` (wallet + trustline to a token: "No trustline, no entry"). Switch modes by running `/bouncer gate` again.
- A wallet already linked to another member can't be used at the door.
- **Railway-ready:** `railway.json`, and `BOUNCER_DATA_FILE` to keep data on a volume.


## 1.1.0

- **Gate:** `/bouncer gate` posts an "Enter the Club" button that gives a role, with a short wait for new joins and a hold during raids. `/bouncer welcome` sets a welcome channel.
- **Spam & flood:** fast posting and copy-paste spam (same message 3x, across 3 channels, or a link in 2) are cleared, every copy deleted, poster timed out.
- **Strikes & cases:** `/warn`, `/unwarn`, `/cases`. Automatic removals count too. Strikes expire after 30 days and escalate (2 → 6h, 3 → 24h + "consider a ban").
- **Live lists:** `/bouncer domain|name|address` and `/bouncer lists`. No restart. A runtime block beats an allow.
- **Xaman wallet linking:** `/wallet link|show|unlink` using a SignIn request only. One wallet per member.
- **Holder roles:** `/holder add|list|remove|sync` for trustline/token, NFT (with taxon) or XRP-balance rules. Re-checked daily and on link.
- **XRPL lookups:** `/xrpl account|tx|domain`, read-only. `domain` checks `xrp-ledger.toml` and two-way account/domain matches.
- **Scam addresses:** messages with a listed r-address are removed. Bait plus any r-address is removed.
- Data now lives in `data/bouncer.json`. Invite permissions add Manage Roles.


## 1.0.1

- **Fix:** normal chat made of 12+ seed-list words was deleted as a "recovery phrase". Phrases now have to pass the BIP39 checksum, and a long message also has to not read like a sentence. A message that is just the phrase is always caught.
- **Fix:** bare domains with less common endings (`xrp.cafe`, `xaman.support`, `.claims`, `.wallet`, ...) were not seen as links.
- **Change:** removed `terry` from `protectedNames`. Members actually named Terry were timed out; `trustline terry` is still protected.
- **Fix:** username / display-name changes are now checked for impersonation (previously only nicknames).
- **Fix:** edits to messages sent before a restart are now re-checked.
- **Fix:** mods with Manage Messages can press **Handled** on logs; Timeout / Lift timeout still need Timeout Members.
- **Fix:** turning raid mode off manually clears the join window, so it can't re-trip on the next join.

## 1.0.0

- First release.
