// Internal placeholder subpath. The capnweb runtime imports `validators` from
// here at startup; `capnweb typecheck gen` overwrites this file in-place with
// generated validators. While the placeholder is in place runtime validation
// is a no-op. Not part of capnweb's public API — do not import directly.

import type { RpcClassValidators } from "./core.js";

export const validators: Record<string, RpcClassValidators> | null = null;

/**
 * When true, the runtime throws on the first call into an `RpcTarget`
 * subclass that has no entry in `validators` (instead of silently skipping
 * validation). Set by `capnweb typecheck gen --strict` to catch missed
 * regenerations after a class is renamed or a new class is added.
 */
export const strict: boolean = false;
