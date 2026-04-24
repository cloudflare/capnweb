---
"capnweb": minor
---

Add `Blob` as a serializable type over RPC. `Blob` objects can now be passed as call arguments and return values. The MIME type (`blob.type`) is preserved across the wire.
