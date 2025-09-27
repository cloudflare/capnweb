// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { expect, it, describe, beforeEach, afterEach } from "vitest";
import { RpcTarget, RpcStub, newMessagePortRpcSession } from "../src/index.js";

describe("Issue #55: RPC target property access", () => {
  let originalWarn: typeof console.warn;
  let warnings: string[];

  beforeEach(() => {
    // Spy on console.warn to capture warnings
    warnings = [];
    originalWarn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
  });

  afterEach(() => {
    // Restore original console.warn
    console.warn = originalWarn;
  });

  it("should return undefined when accessing instance properties on RpcTarget and log warning", async () => {
    // Setup - Create an RpcTarget with an instance property
    interface MyApi extends RpcTarget {
      instanceProp: number;
      getInstanceProp(): number;
    }

    class MyApiImpl extends RpcTarget implements MyApi {
      instanceProp: number = 42;

      getInstanceProp(): number {
        return this.instanceProp;
      }
    }

    // Set up RPC communication channel
    const { port1, port2 } = new MessageChannel();
    await using stub: RpcStub<MyApi> = newMessagePortRpcSession<MyApi>(port2);
    await using _session = newMessagePortRpcSession(port1, new MyApiImpl());

    // Test accessing instance property directly (should return undefined and warn)
    const propValue = await stub.instanceProp;

    // Assertions
    expect(propValue).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Cap\'n Web Warning: Attempted to access instance property "instanceProp"');
    expect(warnings[0]).toContain('Instance properties are not accessible over RPC for security');
    expect(warnings[0]).toContain('To expose this value, define a getter for it');

    // Test that methods still work correctly
    const methodResult = await stub.getInstanceProp();
    expect(methodResult).toBe(42);
  });

  it("should allow access to prototype methods but not instance properties", async () => {
    interface TestApi extends RpcTarget {
      instanceProp: string;
      prototypeMethod(): string;
    }

    class TestApiImpl extends RpcTarget implements TestApi {
      instanceProp: string = "instance value";

      prototypeMethod(): string {
        return "prototype method result";
      }
    }

    const { port1, port2 } = new MessageChannel();
    await using stub: RpcStub<TestApi> = newMessagePortRpcSession<TestApi>(port2);
    await using _session = newMessagePortRpcSession(port1, new TestApiImpl());

    // Instance property should return undefined and warn
    const propValue = await stub.instanceProp;
    expect(propValue).toBeUndefined();
    expect(warnings).toHaveLength(1);

    // Prototype method should work normally
    const methodResult = await stub.prototypeMethod();
    expect(methodResult).toBe("prototype method result");
  });

  it("should work correctly with getters (recommended approach)", async () => {
    interface GetterApi extends RpcTarget {
      readonly exposedValue: number;
    }

    class GetterApiImpl extends RpcTarget implements GetterApi {
      private _value: number = 123;

      get exposedValue(): number {
        return this._value;
      }
    }

    const { port1, port2 } = new MessageChannel();
    await using stub: RpcStub<GetterApi> = newMessagePortRpcSession<GetterApi>(port2);
    await using _session = newMessagePortRpcSession(port1, new GetterApiImpl());

    // Getter should work correctly without warnings
    const value = await stub.exposedValue;
    expect(value).toBe(123);
    expect(warnings).toHaveLength(0); // No warnings for getters
  });
});