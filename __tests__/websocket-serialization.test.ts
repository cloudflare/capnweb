// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { expect, it, describe } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import { newWebSocketRpcSession, RpcTarget } from "../src/index.js";

function listenWebSocket(server: WebSocketServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.on("listening", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeWebSocket(server: WebSocketServer): Promise<void> {
  return new Promise(resolve => {
    for (let client of server.clients) client.terminate();
    server.close(() => resolve());
  });
}

function waitOpen(socket: WsWebSocket): Promise<void> {
  if (socket.readyState === WsWebSocket.OPEN) return Promise.resolve();

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), {
      once: true,
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nextMessage(socket: { addEventListener(type: "message", listener: (event: any) => void, options?: any): void })
    : Promise<string | Uint8Array> {
  return new Promise(resolve => {
    socket.addEventListener("message", event => resolve(event.data), { once: true });
  });
}

function nextClose(socket: { addEventListener(type: "close", listener: (event: any) => void, options?: any): void })
    : Promise<{ code: number, reason: string }> {
  return new Promise(resolve => {
    socket.addEventListener("close", event => {
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
  });
}

function responseWithWebSocket(socket: WebSocket): Response {
  let response = new Response(null, { status: 204 });
  Object.defineProperty(response, "webSocket", { value: socket });
  return response;
}

describe("WebSocket serialization", () => {
  it("can pass a live WebSocket through an RPC result", async () => {
    let echoServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    echoServer.on("connection", socket => {
      socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
    });
    let echoPort = await listenWebSocket(echoServer);

    class Api extends RpcTarget {
      async open() {
        let socket = new WsWebSocket(`ws://127.0.0.1:${echoPort}`);
        await waitOpen(socket);
        return socket;
      }

      async openResponse() {
        let socket = new WsWebSocket(`ws://127.0.0.1:${echoPort}`);
        await waitOpen(socket);
        return responseWithWebSocket(socket as any);
      }
    }

    let rpcServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    rpcServer.on("connection", socket => {
      newWebSocketRpcSession(socket as any, new Api());
    });
    let rpcPort = await listenWebSocket(rpcServer);

    let api: any = newWebSocketRpcSession(new WsWebSocket(`ws://127.0.0.1:${rpcPort}`) as any);
    try {
      let socket: any = await api.open();
      let message = nextMessage(socket);
      socket.send("hello over a bridged socket");

      expect(await withTimeout(message)).toBe("hello over a bridged socket");

      let binaryMessage = nextMessage(socket);
      socket.send(new Uint8Array([1, 2, 3]).buffer);
      let bytes = await withTimeout(binaryMessage);
      expect(typeof bytes).not.toBe("string");
      expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3]);

      let close = nextClose(socket);
      socket.close(1000, "done");
      expect(await withTimeout(close)).toEqual({ code: 1000, reason: "done" });
      socket.close();

      let response: any = await api.openResponse();
      expect(response.status).toBe(204);
      expect(response.webSocket).toBeTruthy();

      let responseMessage = nextMessage(response.webSocket);
      response.webSocket.send("hello through Response.webSocket");
      expect(await withTimeout(responseMessage)).toBe("hello through Response.webSocket");
      response.webSocket.close();
    } finally {
      await closeWebSocket(rpcServer);
      await closeWebSocket(echoServer);
    }
  }, 10_000);

  it("can run Cap'n Web over a WebSocket tunneled through Cap'n Web", async () => {
    class Processor extends RpcTarget {
      square(value: number) { return value * value; }
      greet(name: string) { return `hello ${name}`; }
    }

    let processorServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    processorServer.on("connection", socket => {
      newWebSocketRpcSession(socket as any, new Processor());
    });
    let processorPort = await listenWebSocket(processorServer);

    class TunnelTarget extends RpcTarget {
      async fetch(request: Request): Promise<Response> {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Expected a WebSocket upgrade.", { status: 426 });
        }

        let socket = new WsWebSocket(`ws://127.0.0.1:${processorPort}`);
        await waitOpen(socket);

        let response = new Response(null);
        Object.defineProperty(response, "webSocket", { value: socket });
        return response;
      }
    }

    let tunnelServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    tunnelServer.on("connection", socket => {
      newWebSocketRpcSession(socket as any, new TunnelTarget());
    });
    let tunnelPort = await listenWebSocket(tunnelServer);

    let tunnelApi: any =
        newWebSocketRpcSession(new WsWebSocket(`ws://127.0.0.1:${tunnelPort}`) as any);
    let response: any = await tunnelApi.fetch(new Request("https://captun.test/processor", {
      headers: { Upgrade: "websocket" },
    }));

    let processor: any = newWebSocketRpcSession(response.webSocket);
    try {
      expect(await processor.square(7)).toBe(49);
      expect(await processor.greet("captun")).toBe("hello captun");
    } finally {
      await closeWebSocket(tunnelServer);
      await closeWebSocket(processorServer);
    }
  }, 10_000);
});
