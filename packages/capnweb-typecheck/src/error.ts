// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

export type PropertyPath = (string | number)[];

/**
 * Structured detail attached to {@link RpcValidationError}. Lets a caller
 * inspect *what* went wrong (which path, expected vs. actual type, original
 * value) without parsing the error message.
 */
export type RpcValidationFailure = {
  path: PropertyPath;
  expected: string;
  actual: string;
  value: unknown;
};

/**
 * Thrown by validators injected by the `capnweb-typecheck` transform when an
 * RPC argument or return value fails a type check. Extends {@link TypeError}
 * so existing `instanceof TypeError` catches still match; adds `rpcValidation`
 * for structured inspection.
 *
 * ```ts
 * try {
 *   await stub.method(badArg);
 * } catch (e) {
 *   if (e instanceof RpcValidationError) {
 *     console.log(e.rpcValidation.path, e.rpcValidation.expected);
 *   }
 * }
 * ```
 */
export class RpcValidationError extends TypeError {
  readonly rpcValidation: RpcValidationFailure;

  constructor(message: string, validation: RpcValidationFailure) {
    super(message);
    this.name = "RpcValidationError";
    this.rpcValidation = validation;
    if (typeof (Error as { captureStackTrace?: Function }).captureStackTrace === "function") {
      (Error as { captureStackTrace: Function }).captureStackTrace(this, RpcValidationError);
    }
  }
}
