// A Record / index-signature whose values are stubs must wrap each dynamic-key
// value, so pipelined calls through a received `Record<string, Stub<T>>` are
// validated on the client (the side that receives the return). v.object stores
// its index validator in the shape; wrapResolvedValue and propertyValidatorFor
// consult it for keys not covered by a fixed property.
import { describe, it, expect } from "vitest";
import { v, wrapClientStub, type ServiceValidator } from "../src/internal/core.js";

const userStub = v.stubOf({
  serviceName: "User",
  methods: { getName: { args: [], returns: v.string } },
} as ServiceValidator);

function fakeStub(methods: Record<string, (...a: unknown[]) => unknown>): Record<string, unknown> {
  const s: Record<string, unknown> = { ...methods };
  s.dup = () => fakeStub(methods);
  return s;
}

function service(target: object) {
  const validator: ServiceValidator = {
    serviceName: "Api",
    methods: { getUsers: { args: [], returns: v.object({}, "Rec", userStub) } },
  };
  return wrapClientStub(target, validator) as { getUsers(): Record<string, { getName(): unknown }> };
}

describe("Record / index-signature stub values are wrapped", () => {
  it("validates a pipelined call through a dynamic-key stub value", () => {
    // The dynamic-key stub lies: getName returns a number, not a string.
    const rec = service({ getUsers: () => ({ alice: fakeStub({ getName: () => 12345 }) }) }).getUsers();
    expect(() => rec.alice.getName()).toThrow(TypeError);
  });

  it("passes a correct dynamic-key stub value through", () => {
    const rec = service({ getUsers: () => ({ bob: fakeStub({ getName: () => "ok" }) }) }).getUsers();
    expect(rec.bob.getName()).toBe("ok");
  });

  it("wraps multiple dynamic keys independently", () => {
    const rec = service({
      getUsers: () => ({
        good: fakeStub({ getName: () => "ok" }),
        bad: fakeStub({ getName: () => 99 }),
      }),
    }).getUsers();
    expect(rec.good.getName()).toBe("ok");
    expect(() => rec.bad.getName()).toThrow(TypeError);
  });

  it("still wraps fixed properties alongside the index", () => {
    const validator: ServiceValidator = {
      serviceName: "Api",
      methods: {
        m: {
          args: [],
          // { fixed: Stub<User>, [k: string]: Stub<User> }
          returns: v.object({ fixed: userStub }, "Mixed", userStub),
        },
      },
    };
    const wrapped = wrapClientStub(
      { m: () => ({ fixed: fakeStub({ getName: () => 1 }), dyn: fakeStub({ getName: () => "ok" }) }) },
      validator,
    ) as { m(): Record<string, { getName(): unknown }> };
    const rec = wrapped.m();
    expect(() => rec.fixed.getName()).toThrow(TypeError); // fixed still validated
    expect(rec.dyn.getName()).toBe("ok"); // index still validated
  });

  it("preserves a non-enumerable disposer when cloning a returned object", () => {
    if (typeof Symbol.dispose !== "symbol") return;
    const dispose = (): void => {};
    const value = { alice: fakeStub({ getName: () => "ok" }) };
    Object.defineProperty(value, Symbol.dispose, {
      value: dispose,
      enumerable: false,
    });

    const rec = service({ getUsers: () => value }).getUsers();
    const descriptor = Object.getOwnPropertyDescriptor(rec, Symbol.dispose);
    expect(rec).not.toBe(value);
    expect(descriptor?.value).toBe(dispose);
    expect(descriptor?.enumerable).toBe(false);
  });
});
