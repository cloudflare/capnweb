// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import {
  RpcTarget,
  type RpcClassValidators,
  setRpcMethodValidators,
  setRpcStubValidators,
} from "../core.js";

export function __capnweb_registerRpcValidators(
    classes: Record<string, Function>, validators: Record<string, RpcClassValidators>): void {
  for (let [name, classValidators] of Object.entries(validators)) {
    let klass = classes[name];
    if (!klass) throw new Error(`Missing class '${name}' for Cap'n Web validator.`);
    setRpcMethodValidators(klass, classValidators);
  }
}

export function __capnweb_bindClientValidator<T extends object>(
    stub: T, validators: RpcClassValidators): T {
  setRpcStubValidators(stub, validators);
  return stub;
}

export { RpcTarget };
export type { RpcClassValidators, RpcMethodValidator, RpcValidationOptions } from "../core.js";
