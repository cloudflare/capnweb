---
"capnweb": minor
---

Support serializing `Map` objects over RPC.

`Map` keys follow the same rules as `Set` elements: stubs are allowed, but promises and `Blob`s are
not allowed as direct keys. Sending a `Map` with either as a key over a connection throws a
`TypeError`. `Map` values may be promises, `Blob`s, or stubs.
