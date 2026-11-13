---
"capnweb-validate": patch
---

Fixed `@validateRpc()` methods wrapping an already-existing stub in a `Proxy` when returning it. Over Workers RPC, this caused the returned stub to lose its persistence and made its methods uncallable.
