---
"capnweb": patch
---

Errors properties, using `Object.keys()`, are now preserved across the wire. Attach fields like `code` or `details` to an `Error` and they propagate to the other side. The `cause` and `errors` (for `AggregateError`) properties will also be preserved.
