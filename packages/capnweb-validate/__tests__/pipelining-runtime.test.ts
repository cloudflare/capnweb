import { describe, expect, it, vi } from "vitest";
import { v, validateReturn, type ServiceValidator } from "../src/internal/core.js";
import { RpcValidationError } from "../src/error.js";

// RpcPromise stand-in: a callable proxy with `.then` (what isRpcPromiseLike keys on); pipelined methods hang off the function.
function rpcPromise(
  value: unknown,
  pipeline: Record<string, (...a: unknown[]) => unknown> = {}
): (...a: unknown[]) => unknown {
  const fn = ((): void => {}) as Record<string, unknown> &
    ((...a: unknown[]) => unknown);
  fn.then = (onF?: unknown, onR?: unknown) =>
    Promise.resolve(value).then(onF as never, onR as never);
  for (const [k, m] of Object.entries(pipeline)) fn[k] = m;
  return fn;
}

// A rejecting RpcPromise stand-in.
function rejectingRpcPromise(err: unknown): (...a: unknown[]) => unknown {
  const fn = ((): void => {}) as Record<string, unknown> &
    ((...a: unknown[]) => unknown);
  fn.then = (onF?: unknown, onR?: unknown) =>
    Promise.reject(err).then(onF as never, onR as never);
  return fn;
}

const userStub = (): ReturnType<typeof v.stubOf> =>
  v.stubOf({
    serviceName: "User",
    methods: {
      getName: { args: [], returns: v.string },
      setName: { args: [v.string], returns: v.string },
    },
  } as ServiceValidator);

describe("wrapRpcPromise: resolved-value validation via .then", () => {
  it("resolves when the awaited value matches the return validator", async () => {
    const wrapped = validateReturn(rpcPromise("hello"), v.string, [], "client");
    await expect(Promise.resolve(wrapped)).resolves.toBe("hello");
  });

  it("rejects with RpcValidationError when the resolved value is wrong (throw)", async () => {
    const wrapped = validateReturn(rpcPromise(42), v.string, [], "client");
    await expect(Promise.resolve(wrapped)).rejects.toBeInstanceOf(
      RpcValidationError
    );
  });

  it("warn mode logs and passes the bad value through unchanged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapped = validateReturn(rpcPromise(42), v.string, [], "client", "warn");
    await expect(Promise.resolve(wrapped)).resolves.toBe(42);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("wrapRpcPromise: .catch / .finally delegation", () => {
  it("routes rejections to .catch", async () => {
    const wrapped = validateReturn(
      rejectingRpcPromise(new Error("boom")),
      v.string,
      [],
      "client"
    ) as { catch(f: (e: unknown) => unknown): Promise<unknown> };
    await expect(wrapped.catch(() => "caught")).resolves.toBe("caught");
  });

  it("runs .finally and still yields the validated value", async () => {
    let ran = false;
    const wrapped = validateReturn(rpcPromise("x"), v.string, [], "client") as {
      finally(f: () => void): Promise<unknown>;
    };
    await expect(wrapped.finally(() => (ran = true))).resolves.toBe("x");
    expect(ran).toBe(true);
  });

  it(".finally still rejects a bad resolved value", async () => {
    const wrapped = validateReturn(rpcPromise(99), v.string, [], "client") as {
      finally(f: () => void): Promise<unknown>;
    };
    await expect(wrapped.finally(() => {})).rejects.toBeInstanceOf(
      RpcValidationError
    );
  });
});

describe("wrapRpcPromise: promise pipelining (method access before resolve)", () => {
  it("validates a pipelined call's return value", async () => {
    const p = rpcPromise(undefined, { getName: () => Promise.resolve("Ada") });
    const wrapped = validateReturn(p, userStub(), [], "client") as {
      getName(): Promise<string>;
    };
    await expect(wrapped.getName()).resolves.toBe("Ada");
  });

  it("rejects a pipelined call whose return value is wrong-typed", async () => {
    const p = rpcPromise(undefined, { getName: () => Promise.resolve(123) });
    const wrapped = validateReturn(p, userStub(), [], "client") as {
      getName(): Promise<unknown>;
    };
    await expect(wrapped.getName()).rejects.toBeInstanceOf(RpcValidationError);
  });

  it("throws synchronously on a pipelined call with a bad argument", () => {
    const p = rpcPromise(undefined, { setName: () => Promise.resolve("ok") });
    const wrapped = validateReturn(p, userStub(), [], "client") as {
      setName(x: unknown): Promise<string>;
    };
    expect(() => wrapped.setName(123)).toThrow(RpcValidationError);
  });
});

describe("wrapRpcPromise: allowDeferred for client pipeline placeholders", () => {
  it("accepts an RpcPromise placeholder where a concrete arg is expected (client)", () => {
    const p = rpcPromise(undefined, { setName: () => Promise.resolve("ok") });
    const wrapped = validateReturn(p, userStub(), [], "client") as {
      setName(x: unknown): Promise<string>;
    };
    // The placeholder is itself an RpcPromise (a pipelined id), legal on the
    // client because the real value is checked at the server boundary.
    const placeholder = rpcPromise("deferred");
    expect(() => wrapped.setName(placeholder)).not.toThrow();
  });

  it("still rejects a plain wrong-typed (non-deferred) argument", () => {
    const p = rpcPromise(undefined, { setName: () => Promise.resolve("ok") });
    const wrapped = validateReturn(p, userStub(), [], "client") as {
      setName(x: unknown): Promise<string>;
    };
    expect(() => wrapped.setName(123)).toThrow(RpcValidationError);
  });
});
