// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Library-internal entry point. This module is not part of the user-facing
// API; it is imported only by code emitted by `capnweb-typecheck gen` and
// the Vite plugin. The corresponding subpath in `package.json`
// (`./internal/typecheck`) resolves at runtime to `dist/index.js` so the
// validator state lives in a single bundle alongside the rest of the runtime.

export {
  // Generated-code entry points.
  __capnweb_registerRpcValidators,
  __capnweb_bindClientValidator,
  // Vendored typia helpers. Generated validator modules import these (after
  // our build-time import-rewrite step). They live here so the user's app
  // resolves them through `capnweb` instead of needing `typia` at runtime.
  _validateReport,
  _createStandardSchema,
} from "./typecheck/runtime.js";

export type {
  RpcMethodTypiaValidators,
  RpcClassTypiaValidators,
  RpcTypiaRegistry,
  TypiaValidator,
  TypiaValidationError,
  TypiaValidationResult,
} from "./typecheck/runtime.js";
