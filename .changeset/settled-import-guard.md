---
"capnweb": patch
---

Don't cite a released import id after the reference has settled.

`ImportTableEntry.resolve()` stores the resolution and immediately calls `sendRelease()`, so the
import is dead on both sides — but the entry keeps `importId`, since the release accounting names
the id through it. `getImport()` still returned that id, so passing a settled `RpcPromise` back as
an argument re-serialized a released id. The peer could not find it and threw inside `readLoop`,
which is wrapped in a single session-wide `.catch(err => this.abort(err))` — so a call-level fault
destroyed the whole session. `getImport()` now declines a settled entry and the caller exports a
fresh stub instead, matching `dispose()`, `abort()` and `onBroken()`, which already branch on
`resolution`.
