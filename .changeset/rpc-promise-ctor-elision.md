---
"capnweb": patch
---

The `RpcPromise` constructor now applies the same stub elision as method result types: wrapping a `Promise<RpcStub<T>>` produces the same `RpcPromise<T>` a method declared to return that stub would, plain-interface stub payloads keep their stub type, and promises resolving to inline object literals with methods now infer correctly.
