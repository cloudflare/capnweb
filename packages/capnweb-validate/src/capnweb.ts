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
export { skipRpcValidation, validateRpc, validateStub } from "./index.js";
export type { ValidatedStub } from "./index.js";

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
