---
"capnweb": minor
---

Support RpcTargets (and other RPC stubs) as ReadableStream/WritableStream chunks without disposing their capabilities when `write()` returns. Stream chunk payloads now keep lifecycle tied to the chunk (via `Symbol.dispose` when needed) so methods on streamed stubs remain usable after the write resolves.
