// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";
import { RpcTargetBranded } from "./types.js";
import type { ServerWebSocket } from "bun";

/**
 * Start an RPC session over a Bun ServerWebSocket.
 *
 * Returns both the stub and the transport. The transport must be wired to Bun's
 * `WebSocketHandler` callbacks (`message`, `close`, `error`) by calling its
 * `dispatchMessage`, `dispatchClose`, and `dispatchError` methods.
 *
 * For a zero-wiring alternative, see `newBunWebSocketRpcHandler`.
 */
export function newBunWebSocketRpcSession<T>(
    ws: ServerWebSocket<T>, localMain?: any,
    options?: RpcSessionOptions): { stub: RpcStub, transport: BunWebSocketTransport<T> } {
  let transport = new BunWebSocketTransport<T>(ws);
  let rpc = new RpcSession(transport, localMain, options);
  return { stub: rpc.getRemoteMain(), transport };
}

type WsData = { __capnwebTransport: BunWebSocketTransport<WsData>, __capnwebStub: RpcStub };

/**
 * Create a Bun `WebSocketHandler` object that manages RPC sessions automatically.
 *
 * The returned object can be passed directly as the `websocket` option to `Bun.serve()`.
 * A fresh `localMain` is created for each connection via the `createMain` callback.
 * The transport is stored on `ws.data.__capnwebTransport`.
 *
 * @param createMain Called once per connection to create the main RPC interface for that client.
 * @param options Optional RPC session options applied to every connection.
 */
export function newBunWebSocketRpcHandler(createMain: () => RpcTargetBranded, options?: RpcSessionOptions) {
  return {
    open(ws: ServerWebSocket<WsData>) {
      let transport = new BunWebSocketTransport<WsData>(ws);
      let rpc = new RpcSession(transport, createMain(), options);
      ws.data = { __capnwebTransport: transport, __capnwebStub: rpc.getRemoteMain() };
    },
    message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
      ws.data.__capnwebTransport.dispatchMessage(message);
    },
    close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
      ws.data.__capnwebTransport.dispatchClose(code, reason);
    },
    error(ws: ServerWebSocket<WsData>, error: Error) {
      ws.data.__capnwebTransport.dispatchError(error);
    },
  };
}

export class BunWebSocketTransport<T = undefined> implements RpcTransport {
  constructor (ws: ServerWebSocket<T>) {
    this.#ws = ws;
  }

  #ws: ServerWebSocket<T>;
  #receiveResolver?: (message: string) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: string[] = [];
  #error?: any;

  async send(message: string): Promise<void> {
    this.#ws.send(message);
  }

  async receive(): Promise<string> {
    if (this.#receiveQueue.length > 0) {
      return this.#receiveQueue.shift()!;
    } else if (this.#error) {
      throw this.#error;
    } else {
      return new Promise<string>((resolve, reject) => {
        this.#receiveResolver = resolve;
        this.#receiveRejecter = reject;
      });
    }
  }

  abort?(reason: any): void {
    let message: string;
    if (reason instanceof Error) {
      message = reason.message;
    } else {
      message = `${reason}`;
    }
    this.#ws.close(3000, message);

    if (!this.#error) {
      this.#error = reason;
      // No need to call receiveRejecter(); RPC implementation will stop listening anyway.
    }
  }

  dispatchMessage(data: string | Buffer): void {
    if (this.#error) {
      return;
    }

    let strData = typeof data === "string" ? data : data.toString("utf-8");

    if (this.#receiveResolver) {
      this.#receiveResolver(strData);
      this.#receiveResolver = undefined;
      this.#receiveRejecter = undefined;
    } else {
      this.#receiveQueue.push(strData);
    }
  }

  dispatchClose(code: number, reason: string): void {
    this.#receivedError(new Error(`Peer closed WebSocket: ${code} ${reason}`));
  }

  dispatchError(error: Error): void {
    this.#receivedError(new Error(`WebSocket connection failed.`));
  }

  #receivedError(reason: any) {
    if (!this.#error) {
      this.#error = reason;
      if (this.#receiveRejecter) {
        this.#receiveRejecter(reason);
        this.#receiveResolver = undefined;
        this.#receiveRejecter = undefined;
      }
    }
  }
}
