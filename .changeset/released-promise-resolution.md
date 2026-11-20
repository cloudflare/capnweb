---
"capnweb": patch
---

Stop sending a `resolve` or `reject` message for a promise the peer has already released. Passing a still-pending promise in a call that was forwarded could otherwise invoke `onSendError` with an internal error even though the call succeeded.
