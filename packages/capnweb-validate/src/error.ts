// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

export type PropertyPath = (string | number)[];

// `Symbol.for`, so that a copy of this package bundled twice (its runtime
// beside its public entry, or two versions) still recognizes the other's
// errors. Not a security boundary: the tag never crosses the wire, since
// Cap'n Web sends an error's message and enumerable properties only.
const RPC_VALIDATION_ERROR = Symbol.for("capnweb-validate.validationError");

type TaggedValidationError = TypeError & { [RPC_VALIDATION_ERROR]?: true };

export function newValidationTypeError(message: string): TypeError {
  let err = new TypeError(message) as TaggedValidationError;
  Object.defineProperty(err, RPC_VALIDATION_ERROR, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  let errorCtor = Error as { captureStackTrace?: Function };
  if (typeof errorCtor.captureStackTrace === "function") {
    errorCtor.captureStackTrace(err, newValidationTypeError);
  }
  return err;
}

/**
 * Whether `err` is a refusal by capnweb-validate: a value a validator did not
 * accept, or a method missing from a validated surface. Read from a tag on the
 * error object, so it holds in the process that refused, such as in Cap'n
 * Web's `onSendError`, and not for the error a peer receives.
 */
export function isValidationError(err: unknown): err is TypeError {
  return (
    err instanceof TypeError &&
    (err as TaggedValidationError)[RPC_VALIDATION_ERROR] === true
  );
}
