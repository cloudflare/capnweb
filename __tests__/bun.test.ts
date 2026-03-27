// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { expect, it, test, describe, afterEach } from "bun:test";
import { RpcTarget, RpcStub } from "../src/index.js";
import {
  BunWebSocketTransport,
  newBunWebSocketRpcSession,
  newBunWebSocketRpcHandler,
  newWebSocketRpcSession,
} from "../src/index-bun.js";
import { TestTarget } from "./test-util.js";
import type { Server, ServerWebSocket } from "bun";

let servers: Server[] = [];

afterEach(() => {
  for (let server of servers) {
    server.stop(true);
  }
  servers = [];
});

// Start a Bun server with the given WebSocket handler and return the URL.
function startServer(
    handler: ReturnType<typeof newBunWebSocketRpcHandler>,
): string {
  let server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined as any;
      return new Response("Not Found", { status: 404 });
    },
    websocket: handler,
  });
  servers.push(server);
  return `ws://${server.hostname}:${server.port}`;
}

// Open a WebSocket client and wait for the connection to be established.
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", reject);
  });
}

// Start a server with the handler helper and return a connected RPC stub.
async function startRpcSession(createMain: () => RpcTarget) {
  let handler = newBunWebSocketRpcHandler(createMain);
  let url = startServer(handler);
  return newWebSocketRpcSession(url);
}

describe("BunWebSocketTransport", () => {
  it("sends and receives messages through a real Bun ServerWebSocket", async () => {
    // Stand up a simple echo server that bounces messages back through the
    // transport's dispatch path, exercising real send/receive.
    let serverTransport: BunWebSocketTransport | undefined;
    let handler = {
      open(ws: ServerWebSocket) {
        ws.data = { transport: new BunWebSocketTransport(ws) };
        serverTransport = ws.data.transport;
      },
      message(ws: ServerWebSocket, msg: string | Buffer) {
        ws.data.transport.dispatchMessage(msg);
      },
      close(ws: ServerWebSocket, code: number, reason: string) {
        ws.data.transport.dispatchClose(code, reason);
      },
      error(ws: ServerWebSocket, err: Error) {
        ws.data.transport.dispatchError(err);
      },
    };

    let url = startServer(handler);
    let clientWs = await connect(url);

    // Send a message from the client; the server handler dispatches it into the
    // transport. Then read it back from the server transport to verify the real
    // socket delivered it.
    clientWs.send("hello from client");
    let received = await serverTransport!.receive();
    expect(received).toBe("hello from client");

    // Send a second message to confirm queuing works.
    clientWs.send("second");
    expect(await serverTransport!.receive()).toBe("second");

    clientWs.close();
  });

  it("rejects receive() when the client closes the connection", async () => {
    let serverTransport: BunWebSocketTransport | undefined;
    let handler = {
      open(ws: ServerWebSocket) {
        ws.data = { transport: new BunWebSocketTransport(ws) };
        serverTransport = ws.data.transport;
      },
      message(ws: ServerWebSocket, msg: string | Buffer) {
        ws.data.transport.dispatchMessage(msg);
      },
      close(ws: ServerWebSocket, code: number, reason: string) {
        ws.data.transport.dispatchClose(code, reason);
      },
      error(ws: ServerWebSocket, err: Error) {
        ws.data.transport.dispatchError(err);
      },
    };

    let url = startServer(handler);
    let clientWs = await connect(url);

    let receivePromise = serverTransport!.receive();
    clientWs.close(1000, "bye");
    await expect(receivePromise).rejects.toThrow("Peer closed WebSocket");
  });

  it("closes the underlying socket with code 3000 when abort() is called", async () => {
    let serverTransport: BunWebSocketTransport | undefined;
    let closed = new Promise<{ code: number; reason: string }>((resolve) => {
      let handler = {
        open(ws: ServerWebSocket) {
          ws.data = { transport: new BunWebSocketTransport(ws) };
          serverTransport = ws.data.transport;
        },
        message() {},
        close(ws: ServerWebSocket, code: number, reason: string) {
          resolve({ code, reason });
        },
        error() {},
      };
      startServer(handler);
    });

    // The server was started inside the promise — grab the URL from the
    // last registered server.
    let url = `ws://${servers[servers.length - 1].hostname}:${servers[servers.length - 1].port}`;
    await connect(url);

    serverTransport!.abort!(new Error("test abort"));
    let result = await closed;
    expect(result.code).toBe(3000);
    expect(result.reason).toBe("test abort");
  });
});

describe("newBunWebSocketRpcSession", () => {
  it("returns a stub and transport over a real connection", async () => {
    let serverResult: { stub: any; transport: BunWebSocketTransport } | undefined;
    let handler = {
      open(ws: ServerWebSocket) {
        serverResult = newBunWebSocketRpcSession(ws, new TestTarget());
        ws.data = { transport: serverResult.transport };
      },
      message(ws: ServerWebSocket, msg: string | Buffer) {
        ws.data.transport.dispatchMessage(msg);
      },
      close(ws: ServerWebSocket, code: number, reason: string) {
        ws.data.transport.dispatchClose(code, reason);
      },
      error(ws: ServerWebSocket, err: Error) {
        ws.data.transport.dispatchError(err);
      },
    };

    let url = startServer(handler);
    let clientWs = await connect(url);

    expect(serverResult).toBeDefined();
    expect(serverResult!.stub).toBeDefined();
    expect(serverResult!.transport).toBeInstanceOf(BunWebSocketTransport);

    clientWs.close();
  });

  it("supports a full RPC round-trip with manual handler wiring", async () => {
    let handler = {
      open(ws: ServerWebSocket) {
        let { transport } = newBunWebSocketRpcSession(ws, new TestTarget());
        ws.data = { transport };
      },
      message(ws: ServerWebSocket, msg: string | Buffer) {
        ws.data.transport.dispatchMessage(msg);
      },
      close(ws: ServerWebSocket, code: number, reason: string) {
        ws.data.transport.dispatchClose(code, reason);
      },
      error(ws: ServerWebSocket, err: Error) {
        ws.data.transport.dispatchError(err);
      },
    };

    let url = startServer(handler);
    let stub: any = newWebSocketRpcSession(url);

    expect(await stub.square(5)).toBe(25);
    expect(await stub.square(3)).toBe(9);

    stub[Symbol.dispose]();
  });

  it("propagates errors from the remote target over a real connection", async () => {
    let handler = {
      open(ws: ServerWebSocket) {
        let { transport } = newBunWebSocketRpcSession(ws, new TestTarget());
        ws.data = { transport };
      },
      message(ws: ServerWebSocket, msg: string | Buffer) {
        ws.data.transport.dispatchMessage(msg);
      },
      close(ws: ServerWebSocket, code: number, reason: string) {
        ws.data.transport.dispatchClose(code, reason);
      },
      error(ws: ServerWebSocket, err: Error) {
        ws.data.transport.dispatchError(err);
      },
    };

    let url = startServer(handler);
    let stub: any = newWebSocketRpcSession(url);

    await expect(Promise.resolve(stub.throwError())).rejects.toThrow("test error");

    stub[Symbol.dispose]();
  });

  it("supports bi-directional RPC where the server calls a client-provided callback", async () => {
    let handler = {
      open(ws: ServerWebSocket) {
        let { transport } = newBunWebSocketRpcSession(ws, new TestTarget());
        ws.data = { transport };
      },
      message(ws: ServerWebSocket, msg: string | Buffer) {
        ws.data.transport.dispatchMessage(msg);
      },
      close(ws: ServerWebSocket, code: number, reason: string) {
        ws.data.transport.dispatchClose(code, reason);
      },
      error(ws: ServerWebSocket, err: Error) {
        ws.data.transport.dispatchError(err);
      },
    };

    let url = startServer(handler);
    let stub: any = newWebSocketRpcSession(url);

    let double = new RpcStub((x: number) => x * 2);
    let result = await stub.callFunction(double, 7);
    expect(await result.result).toBe(14);

    stub[Symbol.dispose]();
  });
});

describe("newBunWebSocketRpcHandler", () => {
  it("returns an object with open, message, close, and error handlers", () => {
    let handler = newBunWebSocketRpcHandler(() => new TestTarget());
    expect(typeof handler.open).toBe("function");
    expect(typeof handler.message).toBe("function");
    expect(typeof handler.close).toBe("function");
    expect(typeof handler.error).toBe("function");
  });

  it("serves RPC over a real Bun server", async () => {
    let stub: any = await startRpcSession(() => new TestTarget());

    expect(await stub.square(7)).toBe(49);
    expect(await stub.square(3)).toBe(9);

    stub[Symbol.dispose]();
  });

  it("creates a fresh API instance per connection", async () => {
    let connectionCount = 0;
    let handler = newBunWebSocketRpcHandler(() => {
      connectionCount++;
      return new TestTarget();
    });
    let url = startServer(handler);

    let stub1: any = newWebSocketRpcSession(url);
    await stub1.square(1);

    let stub2: any = newWebSocketRpcSession(url);
    await stub2.square(2);

    expect(connectionCount).toBe(2);

    stub1[Symbol.dispose]();
    stub2[Symbol.dispose]();
  });
});

describe("TestTarget integration", () => {
  test("squares a number", async () => {
    let stub: any = await startRpcSession(() => new TestTarget());
    expect(await stub.square(4)).toBe(16);
    stub[Symbol.dispose]();
  });

  test("creates a counter and increments it", async () => {
    let stub: any = await startRpcSession(() => new TestTarget());
    let counter = stub.makeCounter(10);
    expect(await stub.incrementCounter(counter, 5)).toBe(15);
    expect(await stub.incrementCounter(counter)).toBe(16);
    stub[Symbol.dispose]();
  });

  test("propagates errors thrown by remote methods", async () => {
    let stub: any = await startRpcSession(() => new TestTarget());
    await expect(Promise.resolve(stub.throwError())).rejects.toThrow("test error");
    stub[Symbol.dispose]();
  });

  test("invokes a remote method with another stub as an argument", async () => {
    let stub: any = await startRpcSession(() => new TestTarget());
    let result = await stub.callSquare(stub, 6);
    expect(await result.result).toBe(36);
    stub[Symbol.dispose]();
  });

  test("returns a Fibonacci sequence", async () => {
    let stub: any = await startRpcSession(() => new TestTarget());
    let fib = await stub.generateFibonacci(10);
    expect(fib).toEqual([0, 1, 1, 2, 3, 5, 8, 13, 21, 34]);
    stub[Symbol.dispose]();
  });

  test("correctly returns null, undefined, and plain numbers", async () => {
    let stub: any = await startRpcSession(() => new TestTarget());
    expect(await stub.returnNull()).toBe(null);
    expect(await stub.returnUndefined()).toBe(undefined);
    expect(await stub.returnNumber(42)).toBe(42);
    stub[Symbol.dispose]();
  });
});
