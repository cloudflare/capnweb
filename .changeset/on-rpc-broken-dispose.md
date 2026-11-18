---
"capnweb": patch
---

Disposing a remote stub and all its dups now unregisters its `onRpcBroken()` callbacks. To keep
listening on a stub received as a call parameter, `.dup()` it.
