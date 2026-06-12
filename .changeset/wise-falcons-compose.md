---
"capnweb-validate": patch
---

Fix `@validateRpc()` breaking decorated classes that extend other decorated classes: prototype methods are now wrapped in place instead of returning a Proxy from the constructor, so subclass-only methods validate correctly, instances stay real branded `RpcTarget`s, and incoming callback stubs pass through as native stubs (opt in to validating them with `validateStub<T>(stub)`).
