// Ambient declaration so the source build (tsup -> rollup DTS) can resolve
// `capnweb/_typecheck-validators` before the dist files exist. The real
// implementation is `src/_typecheck-validators.ts`; both keep their type
// signatures in sync.

declare module "capnweb/_typecheck-validators" {
  import type { RpcClassValidators } from "./core.js";
  export const validators: Record<string, RpcClassValidators> | null;
}
