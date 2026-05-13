// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Library-internal entry point. This module is not part of the user-facing
// API; it is imported only by generated typecheck code and
// the Vite plugin. The corresponding subpath in `package.json`
// (`./internal/typecheck`) resolves at runtime to `dist/index.js` so the
// validator state lives in a single bundle alongside the rest of the runtime.

export {
  RpcTarget,
  __capnweb_registerRpcValidators,
  __capnweb_bindClientValidator,
} from "./typecheck/runtime.js";

export type {
  RpcClassValidators,
  RpcMethodValidator,
  RpcValidationOptions,
} from "./typecheck/runtime.js";
