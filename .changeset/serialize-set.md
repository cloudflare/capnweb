---
"capnweb": minor
---

Support serializing `Set` objects over RPC.

A `Set` can contain stubs, but promises and `Blob`s are not allowed as direct elements. Sending a
`Set` containing either over a connection throws a `TypeError`.
