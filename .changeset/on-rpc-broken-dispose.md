---
"capnweb": patch
---

Fix `onRpcBroken()` callbacks being kept and called at disconnect for remote stubs already
disposed. That includes call parameters, so `.dup()` one to keep listening.
