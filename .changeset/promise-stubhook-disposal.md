---
"capnweb": patch
---

Fix RPC argument and capture leaks on failure paths: call arguments are now reliably disposed when a call is rejected, delivered to a broken or disposed stub, or fails to serialize.
