---
"capnweb": minor
---

Return a disposable registration from `onRpcBroken()` so callers can stop listening without disposing the stub. Disposing a stub now also removes its registered callbacks.
