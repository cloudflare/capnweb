// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcStub } from "./core.js";
import { RpcTransportWithCustomEncoding, RpcSession, RpcSessionOptions } from "./rpc.js";
import { consumeTransferableArrayBuffer, hasMarkedTransferableBuffers } from "./serialize.js";

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

class MessagePortTransport implements RpcTransportWithCustomEncoding {
  readonly encodingLevel = "structuredClonable" as const;

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
      } else {
        // Accept any structured-clonable data
        if (this.#receiveResolver) {
          this.#receiveResolver(event.data);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(event.data);
        }
      }
    });

    port.addEventListener("messageerror", (event: MessageEvent) => {
      this.#receivedError(new Error("MessagePort message error."));
    });
  }

  #port: MessagePort;
  #receiveResolver?: (message: unknown) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: unknown[] = [];
  #error?: any;

  send(message: unknown): void {
    if (this.#error) {
      throw this.#error;
    }
    let transfer: ArrayBuffer[] | undefined;
    if (hasMarkedTransferableBuffers()) {
      collectTransferableBuffers(message, (buffer) => {
        transfer ??= [];
        transfer.push(buffer);
      });
    }
    if (transfer !== undefined) {
      this.#port.postMessage(message, transfer);
    } else {
      this.#port.postMessage(message);
    }
  }

  async receive(): Promise<unknown> {
    if (this.#receiveQueue.length > 0) {
      return this.#receiveQueue.shift()!;
    } else if (this.#error) {
      throw this.#error;
    } else {
      return new Promise<unknown>((resolve, reject) => {
        this.#receiveResolver = resolve;
        this.#receiveRejecter = reject;
      });
    }
  }

  abort(reason: any): void {
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

function collectTransferableBuffers(
    value: unknown, onTransferable: (buffer: ArrayBuffer) => void): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectTransferableBuffers(value[i], onTransferable);
    }
  } else if (ArrayBuffer.isView(value)) {
    if (consumeTransferableArrayBuffer(value.buffer)) {
      onTransferable(value.buffer);
    }
  } else if (consumeTransferableArrayBuffer(value)) {
    onTransferable(value);
  } else if (value !== null && typeof value === "object") {
    let proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      for (let key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          collectTransferableBuffers((value as Record<string, unknown>)[key], onTransferable);
        }
      }
    }
  }
}
