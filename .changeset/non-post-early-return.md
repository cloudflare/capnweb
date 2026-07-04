---
"capnweb": patch
---

Fix nodeHttpBatchRpcResponse leaving the connection open and crashing with
ERR_HTTP_HEADERS_SENT on non-POST requests. It now returns 405 immediately.
