---
"capnweb": patch
---

Fix RPC argument and capture leaks on failure paths: call arguments are now reliably disposed when a call is rejected, delivered to a broken or disposed stub, or fails to serialize. Internally, `StubHook.call()`/`stream()`/`map()` now document and follow a callee-takes-ownership contract, even on synchronous throw.
