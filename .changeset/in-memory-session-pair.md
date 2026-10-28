---
"capnweb": minor
---

Add `newInMemoryRpcSessionPair()`, which connects a client and server session in memory for tests. Its `main` (and optional `clientMain`) may implement part of an interface, typed against `T` (and `C`).
