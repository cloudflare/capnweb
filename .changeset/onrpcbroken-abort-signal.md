---
"capnweb": minor
---

`onRpcBroken()` now takes an optional `AbortSignal`: `stub.onRpcBroken(cb, { signal })`. Aborting the signal drops the callback, and a signal that is already aborted registers nothing, even when the stub is already broken.

Disposing a stub now drops the callbacks registered on it. This changes existing behavior. Previously, disposing a stub or promise left its `onRpcBroken()` callbacks registered, so they still fired when the connection was later lost. Disposal is per-stub, so callbacks registered on other stubs pointing at the same object still fire.
