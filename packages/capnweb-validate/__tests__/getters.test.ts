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
import { transformFixture, transformError as buildError } from "./helpers.js";

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
      `class Api extends RpcTarget {\n` +
        `  get config(): string { return "x"; }\n` +
        `  async m(): Promise<number> { return 1; }\n` +
        `}`
    );
    expect(code).toMatch(/"config":\s*\{ args: \[\], returns: __rt\.v\.string, isGetter: true \}/);
    expect(code).toMatch(/"m":\s*\{ args: \[\], returns: __rt\.v\.number \}/);
  });

  it("unwraps a Promise-returning getter", () => {
    const code = transform(
      `class Api extends RpcTarget {\n  get config(): Promise<string> { return Promise.resolve("x"); }\n}`
    );
    expect(code).toMatch(/"config":\s*\{ args: \[\], returns: __rt\.v\.string, isGetter: true \}/);
  });

  it("rejects an unsupported getter type at build time (no longer silently dropped)", () => {
    const msg = transformError(
      `class Api extends RpcTarget {\n  get config(): Map<string, number> { return new Map(); }\n}`
    );
    expect(msg).toContain("Api.config");
    expect(msg).toContain("not a capnweb wire type");
  });

  it("skips private and #-prefixed accessors", () => {
    const code = transform(
      `class Api extends RpcTarget {\n` +
        `  private get secret(): string { return "x"; }\n` +
        `  get ok(): string { return "y"; }\n` +
        `}`
    );
    expect(code).toContain('"ok"');
    expect(code).not.toContain('"secret"');
  });

  it("emits getter-style validators for declared data properties", () => {
    const code = transformFixture(
      `interface Api { config: string; }
       export const api = newHttpBatchRpcSession<Api>("/rpc");`,
      {
        shim: `declare module "capnweb" {
  type StubBase<T> = { readonly __RPC_STUB_BRAND: T };
  type Provider<T> = { readonly [K in keyof T]: T[K] };
  export type RpcStub<T> = T extends object ? Provider<T> & StubBase<T> : StubBase<T>;
  export function newHttpBatchRpcSession<T>(url: string): RpcStub<T>;
}`,
        imports: `import { newHttpBatchRpcSession } from "capnweb";\n`,
      }
    ).code;
    expect(code).toMatch(/"config":\s*\{ args: \[\], returns: __rt\.v\.string, isGetter: true \}/);
  });

  it("emits getter-style validators for plain object target properties", () => {
    const code = transformFixture(
      `const target = { config: "x" };`,
      { target: "target" }
    ).code;
    expect(code).toMatch(/"config":\s*\{ args: \[\], returns: __rt\.v\.string, isGetter: true \}/);
  });

  it("server: validates a data property on property read", () => {
    const validator: ServiceValidator = {
      serviceName: "Api",
      methods: { config: { args: [], returns: v.string, isGetter: true } },
    };
    const target = { config: "ok" as unknown };
    const wrapped = wrapServerTarget(target, validator);
    expect(wrapped.config).toBe("ok");
    target.config = 123;
    expect(() => wrapped.config).toThrow(TypeError);
  });

  it("server: validates the getter value on property read", () => {
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
    expect(wrapped.config).toBe("ok"); // good value passes through
    api._v = 123; // inject a value the type lies about
    expect(() => wrapped.config).toThrow(TypeError); // bad value rejected
  });

  it("server: warn mode lets a bad getter value through", () => {
    class Api {
      get config(): string {
        return 123 as unknown as string;
      }
    }
    const validator: ServiceValidator = {
      serviceName: "Api",
      mode: "warn",
      methods: { config: { args: [], returns: v.string, isGetter: true } },
    };
    const wrapped = wrapServerTarget(new Api(), validator);
    expect(wrapped.config).toBe(123); // warn: original value passes through
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
      `class Api extends RpcTarget {\n  fail(): never { throw new Error("x"); }\n}`
    );
    expect(msg).toContain("the never type, which carries no value");
    expect(msg).not.toMatch(/flags=\d+/);
  });
});
