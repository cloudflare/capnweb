---
"capnweb": patch
---

Share one `RpcPromise` alias between `Result` and the public export. Deeply-nested RPC interfaces no longer blow the checker's depth budget: this fixes all "excessively deep" / "excessive stack depth" (TS2589/TS2321) errors under TypeScript 7 (tsgo) and reduces TypeScript 5.9 type instantiations by ~13%. `RpcPromise<T>` for primitive `T` now also carries the pipelining `Provider<T>` surface, matching what stub calls already returned.
