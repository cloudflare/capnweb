---
"capnweb": patch
"capnweb-validate": patch
---

Fix optional members of `T` (`build?: number`) being typed as possibly `undefined` on `RpcStub<T>`, `RpcPromise<T>` and `ValidatedStub<T>`. Reading a stub member always yields a promise, so the member is required again, as it was before 0.13.0; the awaited value is still `number | undefined`.
