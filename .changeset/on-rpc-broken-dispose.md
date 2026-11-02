---
"capnweb": patch
---

Fix `onRpcBroken()` callbacks on disposed remote stubs being kept alive and called when the
connection was later lost.
