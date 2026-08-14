---
"capnweb": patch
---

Establish and document the `StubHook` ownership contract: `call()`, `stream()`, and `map()` take ownership of their args/captures even when they throw synchronously, so callers must never dispose them after invoking. Fix implementations that violated the contract and leaked on failure paths: `RpcImportHook.call()/stream()` (including argument-serialization failures in `sendCall`/`sendStream`), `MapVariableHook`, the default `StubHook.stream()` (leaked the result hook when `pull()` threw), and the map-not-loaded placeholder. `PromiseStubHook` now disposes args only when its backing promise rejects — once resolved, the callee owns them — and its disposal remains ordered behind already-queued calls.
