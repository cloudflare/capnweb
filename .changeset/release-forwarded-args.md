---
"capnweb": patch
---

Fix stubs passed as call arguments never being released when the call is forwarded to a remote stub (including from a `.map()` callback) or made through a pending `RpcPromise`.
