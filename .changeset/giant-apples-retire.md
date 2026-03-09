---
"capnweb": minor
---

When Node's `Buffer` is available, Cap'n Web will now serialize it the same as `Uint8Array`, and will deserialize all byte arrays as `Buffer` by default. `Buffer` is a subclass of `Uint8Array`, so this should be compatible while being convenient in Node apps.
