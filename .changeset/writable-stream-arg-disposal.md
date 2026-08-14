---
"capnweb": patch
---

Fix WritableStream stubs leaking call arguments when the stub was already disposed or the call path was invalid. All failure paths in `WritableStreamStubHook.call()` now dispose the copied arguments, matching ReadableStream behavior.
