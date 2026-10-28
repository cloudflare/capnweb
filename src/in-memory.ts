// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcTransport } from "./rpc.js";

// One end of an in-memory connection. Messages keep the string encoding, so they take the same
// serialization path as WebSocket and HTTP batch traffic.
export class InMemoryTransport implements RpcTransport {
  #peer?: InMemoryTransport;
  #queue: string[] = [];
  #receiver?: PromiseWithResolvers<string>;
  #error?: unknown;

  static pair(): [InMemoryTransport, InMemoryTransport] {
    let a = new InMemoryTransport();
    let b = new InMemoryTransport();
    a.#peer = b;
    b.#peer = a;
    return [a, b];
  }

  send(message: string): void {
    let peer = this.#peer;
    if (!peer) return;  // Lost, as on a dropped connection.
    if (peer.#receiver) {
      peer.#receiver.resolve(message);
      peer.#receiver = undefined;
    } else {
      peer.#queue.push(message);
    }
  }

  receive(): Promise<string> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift()!);
    if (!this.#peer) return Promise.reject(this.#error);
    this.#receiver = Promise.withResolvers();
    return this.#receiver.promise;
  }

  // Breaks both directions, as a dropped connection would.
  abort(reason: unknown): void {
    let peer = this.#peer;
    if (!peer) return;
    this.#break(reason);
    peer.#break(reason);
  }

  #break(reason: unknown): void {
    this.#peer = undefined;
    this.#error = reason;
    this.#receiver?.reject(reason);
    this.#receiver = undefined;
  }
}
