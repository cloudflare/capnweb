---
"capnweb": patch
---

Fix a whole-session abort when a settled `RpcPromise` (or a property of one) is passed back as an argument to a later call. Previously this re-sent an import id that had already been released.
