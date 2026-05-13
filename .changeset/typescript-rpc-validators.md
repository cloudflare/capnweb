---
"capnweb": minor
---

Add build-time TypeScript RPC validation codegen.

A new opt-in `capnweb typecheck gen` CLI command and `capnweb/vite` plugin generate runtime validators for `RpcTarget` methods from your TypeScript types. The `capnweb` runtime and typecheck tooling stay dependency-free.

- `capnweb typecheck gen`: `capnweb typecheck gen src/worker.ts --out .capnweb` for Wrangler-style builds.
- `capnweb/vite` plugin: transforms client modules in memory and registers server validators via the worker entry module.
- Server-side: validators are keyed by `RpcTarget` constructor and check arguments before invocation and return values before serialization.
- Client-side: typed factory and `new RpcSession<T>(...)` call sites bind validators to the original `RpcStub`, preserving `RpcPromise` pipelining, disposal, and `StubBase` behavior.
