// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

export type PropertyPath = (string | number)[];

const RPC_VALIDATION_ERROR = Symbol("capnweb-validate.validationError");

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

export function isValidationTypeError(err: unknown): err is TypeError {
  return (
    err instanceof TypeError &&
    (err as TaggedValidationError)[RPC_VALIDATION_ERROR] === true
  );
}
