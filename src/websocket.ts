// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

/// <reference types="@cloudflare/workers-types" />

import { RpcStub } from "./core.js";
import { RpcSession, RpcSessionOptions } from "./rpc.js";

/** Close-frame reason max UTF-8 bytes: 125 payload − 2-byte status (RFC 6455 §5.5). */
export const MAX_CLOSE_REASON_BYTES = 125 - 2;

export function newWebSocketRpcSession(
    webSocket: WebSocket | string, localMain?: any, options?: RpcSessionOptions): RpcStub {
  if (typeof webSocket === "string") {
    webSocket = new WebSocket(webSocket);
  }

  let transport = new WebSocketTransport(webSocket);
  let rpc = new RpcSession(transport, localMain, options);
  return rpc.getRemoteMain();
}

/**
 * For use in Cloudflare Workers: Construct an HTTP response that starts a WebSocket RPC session
 * with the given `localMain`.
 */
export function newWorkersWebSocketRpcResponse(
    request: Request, localMain?: any, options?: RpcSessionOptions): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This endpoint only accepts WebSocket requests.", { status: 400 });
  }

  let pair = new WebSocketPair();
  let server = pair[0];
  server.accept()
  newWebSocketRpcSession(server, localMain, options);
  return new Response(null, {
    status: 101,
    webSocket: pair[1],
  });
}

/**
 * Generic WebSocket transport. Default `T = string` is backward-compatible and satisfies
 * `RpcTransport`. Use `T = ArrayBuffer` as a building block for binary transports.
 */
export class WebSocketTransport<T extends string | ArrayBuffer = string> {
  constructor (webSocket: WebSocket) {
    this.#webSocket = webSocket;

    // Always set binaryType — harmless for string mode, required for ArrayBuffer mode.
    webSocket.binaryType = "arraybuffer";

    if (webSocket.readyState === WebSocket.CONNECTING) {
      this.#sendQueue = [];
      webSocket.addEventListener("open", event => {
        try {
          for (let message of this.#sendQueue!) {
            webSocket.send(message);
          }
        } catch (err) {
          this.#receivedError(err);
        }
        this.#sendQueue = undefined;
      });
    }

    webSocket.addEventListener("message", (event: MessageEvent<any>) => {
      if (this.#error) {
        // Ignore further messages.
      } else if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
        if (this.#receiveResolver) {
          this.#receiveResolver(event.data as T);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(event.data as T);
        }
      } else {
        this.#receivedError(new TypeError("Received unexpected message type from WebSocket."));
      }
    });

    webSocket.addEventListener("close", (event: CloseEvent) => {
      this.#receivedError(new Error(`Peer closed WebSocket: ${event.code} ${event.reason}`));
    });

    webSocket.addEventListener("error", (event: Event) => {
      this.#receivedError(new Error(`WebSocket connection failed.`));
    });
  }

  #webSocket: WebSocket;
  #sendQueue?: T[];  // only if not opened yet
  #receiveResolver?: (message: T) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: T[] = [];
  #error?: any;

  send(message: T): void {
    if (this.#sendQueue === undefined) {
      this.#webSocket.send(message);
    } else {
      // Not open yet, queue for later.
      this.#sendQueue.push(message);
    }
  }

  receive(): Promise<T> {
    if (this.#receiveQueue.length > 0) {
      return Promise.resolve(this.#receiveQueue.shift()!);
    } else if (this.#error) {
      return Promise.reject(this.#error);
    } else {
      return new Promise<T>((resolve, reject) => {
        this.#receiveResolver = resolve;
        this.#receiveRejecter = reject;
      });
    }
  }

  abort(reason: any): void {
    let message: string;
    if (reason instanceof Error) {
      message = reason.message;
    } else {
      message = `${reason}`;
    }
    // `stream: true` drops a trailing partial code point rather than emitting a replacement char.
    let reasonBytes = new TextEncoder().encode(message);
    if (reasonBytes.length > MAX_CLOSE_REASON_BYTES) {
      message = new TextDecoder().decode(reasonBytes.subarray(0, MAX_CLOSE_REASON_BYTES), { stream: true });
    }
    this.#webSocket.close(3000, message);

    if (!this.#error) {
      this.#error = reason;
      // No need to call receiveRejecter(); RPC implementation will stop listening anyway.
    }
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

// This class is generic, so it can't `implements RpcTransport` (that would require every `T` to
// conform, but the ArrayBuffer instantiation intentionally doesn't). The default string
// instantiation's conformance is asserted in __type-tests__/rpc-types.test.ts.
