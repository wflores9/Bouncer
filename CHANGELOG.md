# Changelog

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
