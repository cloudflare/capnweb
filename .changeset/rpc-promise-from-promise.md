---
"capnweb": minor
---

`RpcPromise` can now be constructed from a `Promise`: pipelined calls queue in order until it settles, so you can publish a capability that doesn't exist yet.
