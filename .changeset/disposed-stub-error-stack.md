---
"capnweb": patch
---

Errors thrown when using a disposed RPC stub now carry a stack trace pointing at the disposal site instead of at module initialization. Previously all such errors shared a single module-level Error object, which made stack traces useless for debugging use-after-dispose bugs.
