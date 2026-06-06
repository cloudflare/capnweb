// Getters are a real RPC surface (get(["name"]) reads the accessor over the wire). A prior
// version dropped them, leaking values unvalidated and skipping the build-time wire-type check.
import { describe, it, expect } from "vitest";
import {
  wrapServerTarget,
  wrapClientStub,
  validateReturn,
  v,
  type ServiceValidator,
} from "../src/internal/core.js";
import {
  checkedMethod,
  loadValidator,
  transformFixture,
  transformError as buildError,
} from "./helpers.js";

function transform(body: string): string {
  return transformFixture(body, { target: "new Api()" }).code;
}

function transformError(body: string): string {
  return buildError(body, { target: "new Api()" });
}

// Callable thenable like RpcPromise (function + .then) so the wrapper takes the wrapRpcPromise path.
function fakeRpcPromise(value: unknown): (...a: unknown[]) => unknown {
  const fn = (() => {}) as unknown as Record<string, unknown>;
  fn.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(value).then(onF, onR);
  return fn as unknown as (...a: unknown[]) => unknown;
}

describe("getter accessors on the RPC surface", () => {
  it("emits an isGetter validator for a getter alongside methods", () => {
    const code = transform(
      `class Api extends RpcTarget {
  get config(): string {
    return "x";
  }
  async m(): Promise<number> {
    return 1;
  }
}`
    );
    const validator = loadValidator(code);
    const config = checkedMethod(validator, "config");
    expect(config.returns).toBe(v.string);
    expect(config.isGetter).toBe(true);
    const m = checkedMethod(validator, "m");
    expect(m.returns).toBe(v.number);
    expect(m.isGetter).not.toBe(true);
  });

  it("unwraps a Promise-returning getter", () => {
    const code = transform(
      `class Api extends RpcTarget {
  get config(): Promise<string> {
    return Promise.resolve("x");
  }
}`
    );
    const config = checkedMethod(loadValidator(code), "config");
    expect(config.returns).toBe(v.string);
    expect(config.isGetter).toBe(true);
  });

  it("rejects an unsupported getter type at build time (no longer silently dropped)", () => {
    const msg = transformError(
      `class Api extends RpcTarget {
  get config(): WeakMap<object, number> {
    return new WeakMap();
  }
}`
    );
    expect(msg).toContain("Api.config");
    expect(msg).toContain("not a supported RPC validation type");
  });

  it("skips private and #-prefixed accessors", () => {
    const code = transform(
      `class Api extends RpcTarget {
  private get secret(): string {
    return "x";
  }
  get ok(): string {
    return "y";
  }
}`
    );
    expect(Object.keys(loadValidator(code).methods)).toEqual(["ok"]);
  });

  it("emits getter-style validators for declared data properties", () => {
    const code = transformFixture(
      `interface Api {
  config: string;
}
const target: Api = { config: "x" };`,
      { target: "target" }
    ).code;
    const config = checkedMethod(
      loadValidator(code, "__capnweb_validate_Api_server"),
      "config"
    );
    expect(config.returns).toBe(v.string);
    expect(config.isGetter).toBe(true);
  });

  it("emits getter-style validators for plain object target properties", () => {
    const code = transformFixture(
      `const target = { config: "x" };`,
      { target: "target" }
    ).code;
    const config = checkedMethod(
      loadValidator(code, "__capnweb_validate___object_server"),
      "config"
    );
    expect(config.returns).toBe(v.string);
    expect(config.isGetter).toBe(true);
  });

  it("server: passes a getter read through unvalidated (the client checks returns)", () => {
    const validator: ServiceValidator = {
      serviceName: "Api",
      methods: { config: { args: [], returns: v.string, isGetter: true } },
    };
    const target = { config: "ok" as unknown };
    const wrapped = wrapServerTarget(target, validator);
    expect(wrapped.config).toBe("ok");
    target.config = 123;
    expect(wrapped.config).toBe(123); // outgoing read is not checked on the server
  });

  it("server: passes a getter value through unvalidated", () => {
    class Api {
      _v: unknown = "ok";
      get config(): string {
        return this._v as string;
      }
    }
    const validator: ServiceValidator = {
      serviceName: "Api",
      methods: { config: { args: [], returns: v.string, isGetter: true } },
    };
    const api = new Api();
    const wrapped = wrapServerTarget(api, validator);
    expect(wrapped.config).toBe("ok");
    api._v = 123; // a value the type lies about
    expect(wrapped.config).toBe(123); // server does not validate outgoing reads
  });

  it("client: validates a pipelined getter's resolved value", async () => {
    const validator: ServiceValidator = {
      serviceName: "User",
      methods: { config: { args: [], returns: v.string, isGetter: true } },
    };

    const good = fakeRpcPromise(undefined) as ReturnType<
      typeof fakeRpcPromise
    > & { config?: unknown };
    good.config = fakeRpcPromise("Ada");
    const goodVal = await (validateReturn(
      good,
      v.stubOf(validator),
      ["Api", "user", "<return>"],
      "client"
    ) as { config: Promise<string> }).config;
    expect(goodVal).toBe("Ada");

    const bad = fakeRpcPromise(undefined) as ReturnType<
      typeof fakeRpcPromise
    > & { config?: unknown };
    bad.config = fakeRpcPromise(123);
    let err: unknown;
    try {
      await (validateReturn(
        bad,
        v.stubOf(validator),
        ["Api", "user", "<return>"],
        "client"
      ) as { config: Promise<string> }).config;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TypeError);
  });

  it("client: validates the getter's resolved value", async () => {
    const validator: ServiceValidator = {
      serviceName: "Api",
      methods: { config: { args: [], returns: v.string, isGetter: true } },
    };
    // Wrapped getter is a callable thenable, so await manually; .resolves/.rejects mishandle these.
    const good = { get config() { return fakeRpcPromise("ok"); } };
    const goodVal = await (wrapClientStub(good, validator) as { config: Promise<string> }).config;
    expect(goodVal).toBe("ok");

    const bad = { get config() { return fakeRpcPromise(123); } };
    let err: unknown;
    try {
      await (wrapClientStub(bad, validator) as { config: Promise<string> }).config;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TypeError);
  });
});

describe("never type", () => {
  it("rejects a never return with a readable reason", () => {
    const msg = transformError(
      `class Api extends RpcTarget {
  fail(): never {
    throw new Error("x");
  }
}`
    );
    expect(msg).toContain("the never type, which carries no value");
    expect(msg).not.toContain("flags=");
  });
});
