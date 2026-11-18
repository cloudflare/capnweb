---
"capnweb": patch
---

Fix `ReadableStream`s and `Request`/`Response` bodies failing in calls forwarded to another session or made through a pending `RpcPromise`.
