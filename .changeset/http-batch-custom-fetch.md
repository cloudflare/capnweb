---
"capnweb": minor
---

`newHttpBatchRpcSession()` now accepts an optional `fetch` function in its options, used instead
of the global `fetch()` to send the batch. This makes it possible to send batches through a VPC or
service binding without overriding `globalThis.fetch`.
