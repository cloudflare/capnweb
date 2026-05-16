// Internal placeholder. Do not import this package directly.
import type { RpcClassValidators } from "capnweb/internal/typecheck";

/**
 * Map of RPC class name → method validators. When null, runtime validation is
 * disabled. Overwritten in-place by `capnweb typecheck gen`.
 */
export declare const validators: Record<string, RpcClassValidators> | null;
