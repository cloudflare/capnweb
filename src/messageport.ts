// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";

// Start a MessagePort session given a MessagePort or a pair of MessagePorts.
//
// `localMain` is the main RPC interface to expose to the peer. Returns a stub for the main
// interface exposed from the peer.
export function newMessagePortRpcSession(
    port: MessagePort, localMain?: any, options?: RpcSessionOptions): RpcStub {
  let transport = new MessagePortTransport(port);
  let rpc = new RpcSession(transport, localMain, options);
  return rpc.getRemoteMain();
}

class MessagePortTransport implements RpcTransport {
  constructor (port: MessagePort) {
    this.#port = port;

    // Start listening for messages
    port.start();

    port.addEventListener("message", (event: MessageEvent<any>) => {
      if (this.#error) {
        // Ignore further messages.
      } else if (event.data === null) {
        // Peer is signaling that they're closing the connection
        this.#receivedError(new Error("Peer closed MessagePort connection."));
      } else if (typeof event.data === "string" ||
                 event.data instanceof ArrayBuffer) {
        if (this.#receiveResolver) {
          this.#receiveResolver(event.data);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(event.data);
        }
      } else {
        this.#receivedError(new TypeError("Received non-string message from MessagePort."));
      }
    });

    port.addEventListener("messageerror", (event: MessageEvent) => {
      this.#receivedError(new Error("MessagePort message error."));
    });
  }

  #port: MessagePort;
  #receiveResolver?: (message: string | ArrayBuffer) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: (string | ArrayBuffer)[] = [];
  #error?: any;

  async send(message: string | ArrayBuffer): Promise<void> {
    if (this.#error) {
      throw this.#error;
    }
    this.#port.postMessage(message);
  }

  async receive(): Promise<string | ArrayBuffer> {
    if (this.#receiveQueue.length > 0) {
      return this.#receiveQueue.shift()!;
    } else if (this.#error) {
      throw this.#error;
    } else {
      return new Promise<string | ArrayBuffer>((resolve, reject) => {
        this.#receiveResolver = resolve;
        this.#receiveRejecter = reject;
      });
    }
  }

  abort?(reason: any): void {
    // Send close signal to peer before closing
    try {
      this.#port.postMessage(null);
    } catch (err) {
      // Ignore errors when sending close signal - port might already be closed
    }

    this.#port.close();

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