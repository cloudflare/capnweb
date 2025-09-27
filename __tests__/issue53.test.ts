// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { expect, it, describe } from "vitest";
import { newHttpBatchRpcSession, newWebSocketRpcSession } from "../src/index.js";

describe("Issue #53: Type instantiation excessively deep for untyped sessions", () => {
  it("should not cause type instantiation errors for untyped HTTP batch sessions", () => {
    // Before the fix, this would cause:
    // "Type instantiation is excessively deep and possibly infinite.ts(2589)"
    const httpSession = newHttpBatchRpcSession("http://example.com");
    expect(httpSession).toBeDefined();

    // RPC stubs are proxied functions, so they appear as "function" type
    expect(typeof httpSession).toBe("function");
  });

  it("should not cause type instantiation errors for untyped WebSocket sessions", () => {
    // This should work (already had default type parameter)
    const wsSession = newWebSocketRpcSession("ws://example.com");
    expect(wsSession).toBeDefined();

    // RPC stubs are proxied functions, so they appear as "function" type
    expect(typeof wsSession).toBe("function");
  });

  it("should work with explicit type parameters (typed sessions)", () => {
    // Explicit typing should continue to work as before
    interface MyApi {
      ping(): Promise<string>;
      getData(): Promise<number>;
    }

    const typedHttp = newHttpBatchRpcSession<MyApi>("http://example.com");
    const typedWs = newWebSocketRpcSession<MyApi>("ws://example.com");

    expect(typedHttp).toBeDefined();
    expect(typedWs).toBeDefined();
    expect(typeof typedHttp).toBe("function");
    expect(typeof typedWs).toBe("function");

    // These should have the correct types (checked at compile time)
    // The calls themselves would fail at runtime since we're not connected to real servers,
    // but TypeScript should accept them syntactically
    expect(typeof typedHttp.ping).toBe("function");
    expect(typeof typedWs.getData).toBe("function");
  });

  it("should return Empty-typed stubs for untyped sessions", () => {
    // The untyped sessions should return RpcStub<Empty> which behaves like unknown
    const httpSession = newHttpBatchRpcSession("http://example.com");
    const wsSession = newWebSocketRpcSession("ws://example.com");

    expect(httpSession).toBeDefined();
    expect(wsSession).toBeDefined();

    // These should be functions with RPC stub behavior (due to proxy)
    expect(typeof httpSession).toBe("function");
    expect(typeof wsSession).toBe("function");

    // They should have the basic stub methods
    expect(typeof httpSession.dup).toBe("function");
    expect(typeof wsSession.dup).toBe("function");
  });
});