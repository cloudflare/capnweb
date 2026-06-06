import { describe, expect, it, vi } from "vitest";
import { v, validateReturn, type ServiceValidator } from "../src/internal/core.js";

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

  it("rejects with TypeError when the resolved value is wrong (throw)", async () => {
    const wrapped = validateReturn(rpcPromise(42), v.string, [], "client");
    await expect(Promise.resolve(wrapped)).rejects.toBeInstanceOf(
      TypeError
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
      TypeError
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
    await expect(wrapped.getName()).rejects.toBeInstanceOf(TypeError);
  });

  it("does not validate a pipelined call's outgoing argument (the server does)", () => {
    const p = rpcPromise(undefined, { setName: () => Promise.resolve("ok") });
    const wrapped = validateReturn(p, userStub(), [], "client") as {
      setName(x: unknown): Promise<string>;
    };
    // The client sends args without checking them; the server validates on
    // arrival. A wrong-typed (or RpcPromise placeholder) arg passes through here.
    expect(() => wrapped.setName(123)).not.toThrow();
  });
});
