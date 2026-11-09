// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

/// <reference types="@cloudflare/workers-types" />

import { RpcStub } from "./core.js";
import { RpcSession, RpcSessionOptions, RpcTransportWithCustomEncoding } from "./rpc.js";
import {
  DEFAULT_LIMITS,
  decodeBinaryFrame,
  encodeBinaryFrame,
  stringifyWithBase64Bytes,
} from "./serialize.js";

/** Close-frame reason max UTF-8 bytes: 125 payload - 2-byte status (RFC 6455 section 5.5). */
export const MAX_CLOSE_REASON_BYTES = 125 - 2;

export function newWebSocketRpcSession(
    webSocket: WebSocket | string, localMain?: any, options?: RpcSessionOptions): RpcStub {
  if (typeof webSocket === "string") {
    webSocket = new WebSocket(webSocket);
  }

  let transport = new WebSocketFrameTransport(webSocket, options);
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
      } else if (
        typeof event.data === "string" ||
        event.data instanceof ArrayBuffer ||
        ArrayBuffer.isView(event.data)
      ) {
        let data: string | ArrayBuffer;
        if (ArrayBuffer.isView(event.data)) {
          let view = event.data;
          data = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength &&
              view.buffer instanceof ArrayBuffer
            ? view.buffer
            : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
        } else {
          data = event.data;
        }
        if (this.#receiveResolver) {
          this.#receiveResolver(data as T);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(data as T);
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

  async send(message: T): Promise<void> {
    if (this.#sendQueue === undefined) {
      try {
        this.#webSocket.send(message);
      } catch (err) {
        this.#receivedError(err);
        throw err;
      }
    } else {
      // Not open yet, queue for later.
      this.#sendQueue.push(message);
    }
  }

  async receive(): Promise<T> {
    if (this.#receiveQueue.length > 0) {
      return this.#receiveQueue.shift()!;
    } else if (this.#error) {
      throw this.#error;
    } else {
      let { promise, resolve, reject } = Promise.withResolvers<T>();
      this.#receiveResolver = resolve;
      this.#receiveRejecter = reject;
      return promise;
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

class WebSocketFrameTransport implements RpcTransportWithCustomEncoding {
  readonly encodingLevel = "jsonCompatibleWithBytes" as const;
  #raw: WebSocketTransport<string | ArrayBuffer>;
  #binary: boolean;
  #autoDetect: boolean;
  #maxMessageSize: number;
  #maxDepth: number;

  constructor(webSocket: WebSocket, options?: RpcSessionOptions) {
    this.#raw = new WebSocketTransport<string | ArrayBuffer>(webSocket);
    this.#binary = options?.binary ?? false;
    this.#autoDetect = options?.binary === undefined;
    this.#maxMessageSize = options?.limits?.maxMessageSize ?? DEFAULT_LIMITS.maxMessageSize;
    this.#maxDepth = options?.limits?.maxDepth ?? DEFAULT_LIMITS.maxDepth;
  }

  send(message: unknown): number {
    if (this.#binary) {
      let frame = encodeBinaryFrame(message);
      this.#raw.send(frame.buffer as ArrayBuffer).catch(() => {});
      return frame.byteLength;
    } else {
      let text = stringifyWithBase64Bytes(message);
      this.#raw.send(text).catch(() => {});
      return text.length;
    }
  }

  async receive(): Promise<unknown> {
    let raw = await this.#raw.receive();
    if (typeof raw === "string") {
      if (raw.length > this.#maxMessageSize) {
        throw new TypeError(
          `Incoming message exceeds maximum size of ${this.#maxMessageSize} UTF-16 code units.`
        );
      }
      return JSON.parse(raw);
    } else {
      if (raw.byteLength > this.#maxMessageSize) {
        throw new TypeError(
          `Incoming message exceeds maximum size of ${this.#maxMessageSize} bytes.`
        );
      }
      let decoded = decodeBinaryFrame(raw, this.#maxDepth * 2 + 2);
      if (this.#autoDetect) {
        this.#binary = true;
      }
      return decoded;
    }
  }

  abort(reason: unknown): void {
    this.#raw.abort(reason);
  }
}
