---
"capnweb": minor
---

Add receiver-side resource limits to guard against untrusted-peer resource exhaustion (#184). Deserialization now caps the length of `bigint` values, accepts both emitted hex strings and legacy decimal strings, bounds message nesting depth across nested call arguments, and rejects oversized incoming messages before parsing. The limits are local, receiver-side decisions with safe defaults (`DEFAULT_LIMITS`), and can be overridden per session via the new `limits` field on `RpcSessionOptions`. Exceeding a limit aborts the session, reusing the existing abort path.

Bigints are now emitted as explicit hex strings (`0x...` or `-0x...`) to keep parsing linear. New receivers continue to accept decimal strings from older senders. Very old receivers accept non-negative hex strings via `BigInt()`, but may reject negative hex strings because JavaScript's `BigInt()` does not parse `-0x...` directly.
