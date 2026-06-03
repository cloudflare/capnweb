// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcTarget } from "./core.js";

/** Inbound frame events delivered from the source socket to the bridged peer. */
type WireEvent =
  | { type: "message"; data: string | Uint8Array }
  | { type: "close"; code: number; reason: string }
  | { type: "error" };

/** The subset of the platform `WebSocket` API we depend on. */
interface WebSocketLike {
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  accept?(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  readyState?: number;
  binaryType?: string;
}

function normalizeData(data: unknown): string | Uint8Array {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    let view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return String(data);
}

export class WebSocketSource extends RpcTarget {
  #socket: WebSocketLike;
  #receiver?: (event: WireEvent) => void;
  #backlog: WireEvent[] = [];
  #closed = false;

  constructor(socket: WebSocketLike) {
    super();
    this.#socket = socket;
    try { socket.accept?.(); } catch { /* already accepted or not supported */ }
    try { socket.binaryType = "arraybuffer"; } catch {}
    socket.addEventListener("message", (e: any) =>
      this.#emit({ type: "message", data: normalizeData(e.data) }));
    socket.addEventListener("close", (e: any) =>
      this.#emit({ type: "close", code: e?.code ?? 1005, reason: e?.reason ?? "" }));
    socket.addEventListener("error", () => this.#emit({ type: "error" }));
  }

  start(receiver: (event: WireEvent) => void): void {
    // Call params are implicitly disposed when the call returns, so retain a duplicate.
    let retained = (receiver as any)?.dup ? (receiver as any).dup() : receiver;
    this.#receiver = retained;
    for (const event of this.#backlog) this.#sendToReceiver(retained, event);
    this.#backlog = [];
  }

  send(data: string | Uint8Array): void {
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }

  [Symbol.dispose](): void {
    (this.#receiver as any)?.[Symbol.dispose]?.();
    this.#receiver = undefined;
    if (!this.#closed && this.#socket.readyState !== 3) {
      try { this.#socket.close(); } catch {}
    }
  }

  #emit(event: WireEvent): void {
    if (event.type === "close") {
      this.#closed = true;
    }

    if (this.#receiver) this.#sendToReceiver(this.#receiver, event);
    else this.#backlog.push(event);
  }

  #sendToReceiver(receiver: (event: WireEvent) => void, event: WireEvent): void {
    Promise.resolve(receiver(event)).catch(() => {});
  }
}

type Listener = (event: any) => void;

export class BridgedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  #stub: any;
  #readyState = BridgedWebSocket.OPEN;
  #listeners: Record<string, Listener[]> = { message: [], close: [], error: [], open: [] };

  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;
  onopen: Listener | null = null;

  constructor(stub: any) {
    // Retain the capability: a stub arriving as a call result is implicitly disposed shortly
    // after that call settles, which would sever the bridge. dup() gives us an owned copy whose
    // lifetime we control (released in close()).
    this.#stub = stub?.dup ? stub.dup() : stub;
    // Begin receiving inbound frames. The callback is invoked via RPC from the source side.
    Promise.resolve(this.#stub.start((event: WireEvent) => this.#dispatch(event)))
      .catch(err => this.#fire("error", { type: "error", error: err }));
  }

  get readyState(): number { return this.#readyState; }

  /** No-op for Workers `WebSocket` API compatibility; the source side already accepted. */
  accept(): void {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.#ignore(this.#stub.send(normalizeData(data)));
  }

  close(code?: number, reason?: string): void {
    if (this.#readyState === BridgedWebSocket.CLOSED) return;
    this.#readyState = BridgedWebSocket.CLOSED;
    this.#ignore(this.#stub.close(code, reason));
    this.#release();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  addEventListener(type: string, listener: Listener): void {
    (this.#listeners[type] ??= []).push(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.#listeners[type];
    if (!list) return;
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  }

  #fire(type: string, event: any): void {
    for (const listener of this.#listeners[type] ?? []) listener(event);
    const handler = (this as any)["on" + type] as Listener | null;
    if (handler) handler(event);
  }

  #ignore(result: any): void {
    if (result?.then) {
      result.then(() => {}, (err: any) => this.#fire("error", { type: "error", error: err }));
    }
  }

  #release(): void {
    this.#stub?.[Symbol.dispose]?.();
    this.#stub = undefined;
  }

  #dispatch(event: WireEvent): void {
    switch (event.type) {
      case "message":
        this.#fire("message", { type: "message", data: event.data });
        break;
      case "close":
        this.#readyState = BridgedWebSocket.CLOSED;
        this.#fire("close", { type: "close", code: event.code, reason: event.reason });
        this.#release();
        break;
      case "error":
        this.#fire("error", { type: "error" });
        break;
    }
  }
}
