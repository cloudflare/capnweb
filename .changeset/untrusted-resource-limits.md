---
"capnweb": minor
---

Add configurable receiver-side resource limits (`RpcSessionOptions.limits`) that cap bigint length, message nesting depth, and incoming message size to guard against untrusted-peer resource exhaustion (#184).
