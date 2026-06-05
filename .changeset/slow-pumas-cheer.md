---
"capnweb": patch
---

Several correctness and robustness fixes:

- Error deserialization now filters inherited `Object.prototype` keys (and `toJSON`) out of an error's own-property bag, matching the behavior already applied when deserializing plain objects. Keys such as `__proto__`, `toString`, and `valueOf` are no longer copied onto deserialized errors.
- Resolving an import that has already been resolved now disposes the redundant resolution instead of overwriting (and leaking) the previous one.
- The `abort` message handler now hands error handlers the unwrapped abort reason rather than the internal payload wrapper, matching the `reject` handler.
- WebSocket close reasons longer than the 123-byte limit are now truncated on a UTF-8 character boundary, so aborting a session with a long reason no longer throws from `WebSocket.close()`.
