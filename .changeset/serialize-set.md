---
"capnweb": minor
---

Support serializing `Set` objects over RPC.

A `Set` carries plain data only: promises, stubs, and `Blob`s are not allowed as elements, and sending one over a connection throws a `TypeError`.
