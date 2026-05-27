// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type * as capnweb from "capnweb";

export {
  deserialize,
  RpcPromise,
  RpcStub,
  RpcTarget,
  serialize,
} from "capnweb";
export type { RpcCompatible, RpcSessionOptions, RpcTransport } from "capnweb";
export { RpcValidationError, skipRpcValidation, validateRpc } from "./index.js";
export type { RpcValidationFailure } from "./error.js";

// Re-exported as a local alias so the value and type share a name without
// hitting TS2323 ("cannot redeclare exported variable") in this module.
export type RpcSession<T extends capnweb.RpcCompatible<T> = undefined> =
  capnweb.RpcSession<T>;

export const RpcSession: typeof capnweb.RpcSession =
  uncompiledMarker as unknown as typeof capnweb.RpcSession;

export const newWebSocketRpcSession: typeof capnweb.newWebSocketRpcSession =
  uncompiledMarker as typeof capnweb.newWebSocketRpcSession;

export const newHttpBatchRpcSession: typeof capnweb.newHttpBatchRpcSession =
  uncompiledMarker as typeof capnweb.newHttpBatchRpcSession;

export const newMessagePortRpcSession: typeof capnweb.newMessagePortRpcSession =
  uncompiledMarker as typeof capnweb.newMessagePortRpcSession;

export const newWorkersRpcResponse: typeof capnweb.newWorkersRpcResponse =
  uncompiledMarker as typeof capnweb.newWorkersRpcResponse;

export const newWorkersWebSocketRpcResponse: typeof capnweb.newWorkersWebSocketRpcResponse =
  uncompiledMarker as typeof capnweb.newWorkersWebSocketRpcResponse;

export const newHttpBatchRpcResponse: typeof capnweb.newHttpBatchRpcResponse =
  uncompiledMarker as typeof capnweb.newHttpBatchRpcResponse;

export const nodeHttpBatchRpcResponse: typeof capnweb.nodeHttpBatchRpcResponse =
  uncompiledMarker as typeof capnweb.nodeHttpBatchRpcResponse;

function uncompiledMarker(): never {
  throw new Error(
    "capnweb-validate marker API was called before it was transformed. " +
      "Configure the capnweb-validate bundler plugin or run the capnweb-validate CLI."
  );
}
