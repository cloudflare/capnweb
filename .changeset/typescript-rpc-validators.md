---
"capnweb": minor
"capnweb-typecheck": minor
---

Add build-time TypeScript RPC validation codegen.

A new opt-in tooling package, `capnweb-typecheck`, generates runtime validators for `RpcTarget` methods from your TypeScript types. The main `capnweb` package stays dependency-free; the tooling dependencies (`ts-morph` and `typia`) live only in `capnweb-typecheck`.

- `capnweb-typecheck` CLI: `capnweb-typecheck gen src/worker.ts --out .capnweb` for Wrangler-style builds.
- `capnweb-typecheck/vite` plugin: transforms client modules in memory and registers server validators via the worker entry module.
- Server-side: validators are keyed by `RpcTarget` constructor and check arguments before invocation and return values before serialization.
- Client-side: typed factory and `new RpcSession<T>(...)` call sites bind validators to the original `RpcStub`, preserving `RpcPromise` pipelining, disposal, and `StubBase` behavior.
