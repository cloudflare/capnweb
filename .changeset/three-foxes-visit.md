---
"capnweb": patch
---

Fixed base64 encoding of very large byte arrays on platforms that don't support Uint8Array.toBase64().
