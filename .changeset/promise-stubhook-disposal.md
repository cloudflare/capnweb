---
"capnweb": patch
---

Fix RPC argument and capture leaks on failure paths — rejected or broken destination hooks and local call errors now dispose the arguments they own — and keep `PromiseStubHook` disposal ordered behind already-queued calls.
