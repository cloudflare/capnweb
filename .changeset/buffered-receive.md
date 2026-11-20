---
"capnweb": patch
---

Avoid repeatedly shifting buffered WebSocket messages when draining a large receive backlog,
while preserving FIFO ordering and connection-error behavior.
