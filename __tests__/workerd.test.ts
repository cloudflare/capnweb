// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

/// <reference types="@cloudflare/workers-types" />
import { expect, it, describe } from "vitest";
import { RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget, env, DurableObject } from "cloudflare:workers";
import { newHttpBatchRpcSession, newWebSocketRpcSession, RpcStub, RpcTarget } from "../src/index.js";
import { Counter, TestTarget } from "./test-util.js";

class JsCounter extends RpcTarget {
  constructor(private i: number = 0) {
    super();
  }

  increment(amount: number = 1): number {
    this.i += amount;
    return this.i;
  }

  get value() {
    return this.i;
  }
}

class NativeCounter extends RpcTarget {
  constructor(private i: number = 0) {
    super();
  }

  increment(amount: number = 1): number {
    this.i += amount;
    return this.i;
  }

  get value() {
    return this.i;
  }
}

class CounterFactory extends RpcTarget {
  getNative() {
    return new NativeRpcStub(new NativeCounter());
  }

  getNativeEmbedded() {
    return {stub: new NativeRpcStub(new NativeCounter())};
  }

  getJs() {
    return new RpcStub(new JsCounter());
  }

  getJsEmbedded() {
    return {stub: new RpcStub(new JsCounter())};
  }
}

describe("workerd compatibility", () => {
  it("allows native RpcStubs to be created using userspace RpcTargets", async () => {
    let stub = new NativeRpcStub(new JsCounter());
    expect(await stub.increment()).toBe(1);
    expect(await stub.increment()).toBe(2);

    expect(await stub.value).toBe(2);
  })

  it("allows userspace RpcStubs to be created using native RpcTargets", async () => {
    let stub = new RpcStub(new NativeCounter());
    expect(await stub.increment()).toBe(1);
    expect(await stub.increment()).toBe(2);

    expect(await stub.value).toBe(2);
  })

  it("can wrap a native stub in a userspace stub", async () => {
    let stub = new RpcStub(new NativeRpcStub(new NativeCounter()));
    expect(await stub.increment()).toBe(1);
    expect(await stub.increment()).toBe(2);

    expect(await stub.value).toBe(2);
  })

  it("can return a native stub from a userspace call", async () => {
    // Returning a bare stub.
    {
      let factory = new RpcStub(new CounterFactory());
      let stub = await factory.getNative();
      expect(await stub.increment()).toBe(1);
      expect(await stub.increment()).toBe(2);

      expect(await stub.value).toBe(2);
    }

    // Again with a stub wrapped in an object.
    {
      let factory = new RpcStub(new CounterFactory());
      let obj = await factory.getNativeEmbedded();
      expect(await obj.stub.increment()).toBe(1);
      expect(await obj.stub.increment()).toBe(2);

      expect(await obj.stub.value).toBe(2);
    }
  })

  it("can wrap a native promise or property in a userspace stub", async () => {
    // Wrap a native RpcPromise in a userspace stub.
    {
      let factory = new NativeRpcStub(new CounterFactory());
      let stub = new RpcStub(factory.getNative());
      expect(await stub.increment()).toBe(1);
      expect(await stub.increment()).toBe(2);

      expect(await stub.value).toBe(2);
    }

    // Wrap a native RpcProperty in a userspace stub.
    {
      let factory = new NativeRpcStub(new CounterFactory());
      let stub = new RpcStub(factory.getNativeEmbedded().stub);
      expect(await stub.increment()).toBe(1);
      expect(await stub.increment()).toBe(2);

      expect(await stub.value).toBe(2);
    }
  })

  it("can pipeline on a native stub returned from a userspace call", async () => {
    {
      let factory = new RpcStub(new CounterFactory());
      let obj = factory.getNative();
      expect(await obj.increment()).toBe(1);
      expect(await obj.increment()).toBe(2);

      expect(await obj.value).toBe(2);
    }

    {
      let factory = new RpcStub(new CounterFactory());
      let obj = factory.getNativeEmbedded();
      expect(await obj.stub.increment()).toBe(1);
      expect(await obj.stub.increment()).toBe(2);

      expect(await obj.stub.value).toBe(2);
    }
  })

  it("can wrap a userspace stub in a native stub", async () => {
    let stub = new NativeRpcStub(new RpcStub(new JsCounter()));
    expect(await stub.increment()).toBe(1);
    expect(await stub.increment()).toBe(2);

    expect(await stub.value).toBe(2);
  })

  it("can return a userspace stub from a native call", async () => {
    // Returning a bare stub.
    {
      let factory = new NativeRpcStub(new CounterFactory());
      let stub = await factory.getJs();
      expect(await stub.increment()).toBe(1);
      expect(await stub.increment()).toBe(2);

      expect(await stub.value).toBe(2);
    }

    // Again with a stub wrapped in an object.
    {
      let factory = new NativeRpcStub(new CounterFactory());
      let obj = await factory.getJsEmbedded();
      expect(await obj.stub.increment()).toBe(1);
      expect(await obj.stub.increment()).toBe(2);

      expect(await obj.stub.value).toBe(2);
    }
  })

  it("can wrap a userspace promise or property in a native stub", async () => {
    // Wrap a userspace RpcPromise in a native stub.
    {
      let factory = new RpcStub(new CounterFactory());
      let stub = new NativeRpcStub(factory.getJs());
      expect(await stub.increment()).toBe(1);
      expect(await stub.increment()).toBe(2);

      expect(await stub.value).toBe(2);
    }

    // Wrap a userspace property (which is actually also an RpcPromise) in a native stub.
    {
      let factory = new RpcStub(new CounterFactory());
      let stub = new NativeRpcStub(factory.getJsEmbedded().stub);
      expect(await stub.increment()).toBe(1);
      expect(await stub.increment()).toBe(2);

      expect(await stub.value).toBe(2);
    }
  })

  it("can pipeline on a userspace stub returned from a native call", async () => {
    {
      let factory = new NativeRpcStub(new CounterFactory());
      let obj = factory.getJs();
      expect(await obj.increment()).toBe(1);
      expect(await obj.increment()).toBe(2);

      expect(await obj.value).toBe(2);
    }

    {
      let factory = new NativeRpcStub(new CounterFactory());
      let obj = factory.getJsEmbedded();
      expect(await obj.stub.increment()).toBe(1);
      expect(await obj.stub.increment()).toBe(2);

      expect(await obj.stub.value).toBe(2);
    }
  })

  it("can wrap a ServiceStub in an RpcStub", async () => {
    let result = await new RpcStub((<any>env).testServer).greet("World");
    expect(result).toBe("Hello, World!");
  });
});

interface Env {
  testServer: Fetcher
}

interface TestDo extends DurableObject {
  setValue(val: any): void;
  getValue(): any;
}

interface WorkerdTestTarget extends TestTarget {
  getDurableObject(name: string): DurableObjectStub<TestDo>;
}

describe("workerd RPC server", () => {
  it("can accept WebSocket RPC connections", async () => {
    let resp = await (<Env>env).testServer.fetch("http://foo", {headers: {Upgrade: "websocket"}});
    let ws = resp.webSocket;
    expect(ws).toBeTruthy();

    ws!.accept();
    let cap = newWebSocketRpcSession<WorkerdTestTarget>(ws!);

    expect(await cap.square(5)).toBe(25);

    {
      let counter = cap.makeCounter(2);
      expect(await counter.increment(3)).toBe(5);
    }

    {
      let counter = new Counter(4);
      expect(await cap.incrementCounter(counter, 9)).toBe(13);
    }

    // Test that we can pass a Durable Object stub over RPC.
    {
      let foo = cap.getDurableObject("foo");
      foo.setValue(123);

      let bar = await cap.getDurableObject("bar");
      bar.setValue("abc");

      expect(await foo.getValue()).toBe(123);
      expect(await bar.getValue()).toBe("abc");
    }
  })

  it("can accept HTTP batch RPC connections", async () => {
    let cap = newHttpBatchRpcSession<TestTarget>(
        new Request("http://foo", {fetcher: (<Env>env).testServer}));

    let promise1 = cap.square(6);

    let counter = cap.makeCounter(2);
    let promise2 = counter.increment(3);
    let promise3 = cap.incrementCounter(counter, 4);

    expect(await Promise.all([promise1, promise2, promise3]))
        .toStrictEqual([36, 5, 9]);
  })
});
