---
"capnweb": minor
---

Add transport encoding levels so custom RPC transports can work with JSON-compatible objects, raw byte arrays, or structured-clonable messages instead of always receiving JSON strings.

Note: `MessagePort` sessions now post structured-clonable objects over the port instead of JSON strings. This changes the wire format between the two ends of the port, so both ends of a `MessagePort` session must upgrade to this version together.
