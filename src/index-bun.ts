// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

export * from "./index.js";

import type { ServerWebSocket } from "bun";
import type { RpcSessionOptions } from "./rpc.js";
import type { RpcCompatible } from "./types.js";
import { newBunWebSocketRpcSession as newBunWebSocketRpcSessionImpl,
         newBunWebSocketRpcHandler,
         BunWebSocketTransport } from "./bun.js";

export { newBunWebSocketRpcHandler, BunWebSocketTransport };

// Re-declare with the proper type so callers get full typing.
import type { RpcStub } from "./index.js";

interface Empty {}

/**
 * Start an RPC session over a Bun ServerWebSocket.
 *
 * Returns both the RPC stub and the transport. The transport exposes `dispatchMessage`,
 * `dispatchClose`, and `dispatchError` methods that must be wired to Bun's `WebSocketHandler`
 * callbacks. For a zero-wiring alternative, use `newBunWebSocketRpcHandler` instead.
 *
 * @param ws The Bun ServerWebSocket from the `open` callback.
 * @param localMain The main RPC interface to expose to the peer.
 */
export let newBunWebSocketRpcSession:<T extends RpcCompatible<T> = Empty, D = undefined>
    (ws: ServerWebSocket<D>, localMain?: any,
     options?: RpcSessionOptions) => { stub: RpcStub<T>, transport: BunWebSocketTransport<D> } =
    <any>newBunWebSocketRpcSessionImpl;
