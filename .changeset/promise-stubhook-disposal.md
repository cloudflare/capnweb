---
"capnweb": patch
---

Fix `PromiseStubHook` to dispose copied call and stream arguments when the backing promise rejects, and to keep disposal ordered behind calls already queued on the promise.
