---
"capnweb": patch
---

Throw when sending a `ReadableStream` that is locked or was already sent. The receiver used to get a stream that hung or was empty, with no error.
