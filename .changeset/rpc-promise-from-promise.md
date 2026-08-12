---
"capnweb": minor
---

`RpcPromise` can now be constructed by the application from a `Promise` (or any other thenable) for the eventual resolution. Calls pipeline immediately and are queued, in order, until the promise settles, making it possible to publish a capability that doesn't exist yet, e.g. while re-establishing a broken session.
