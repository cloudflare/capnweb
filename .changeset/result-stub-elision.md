---
"capnweb": minor
"capnweb-validate": minor
---

Fixed methods declared to return `Promise<RpcStub<T>>` producing broken stub-of-stub result types; they now type the same as `Promise<T>`. If you annotated such a result as `RpcPromise<RpcStub<T>>`, write `RpcPromise<T>` instead.
