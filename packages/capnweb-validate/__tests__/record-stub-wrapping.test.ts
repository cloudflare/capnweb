// A Record / index-signature whose values are stubs must wrap each dynamic-key
// value, so pipelined calls through `Record<string, Stub<T>>` are validated.
// v.object stores its index validator in the shape; wrapResolvedValue and
// propertyValidatorFor consult it for keys not covered by a fixed property.
import { describe, it, expect } from "vitest";
import { v, wrapServerTarget, type ServiceValidator } from "../src/internal/core.js";

const userStub = v.stubOf({
  serviceName: "User",
  methods: { getName: { args: [], returns: v.string } },
} as ServiceValidator);

function service(target: object) {
  const validator: ServiceValidator = {
    serviceName: "Api",
    methods: { getUsers: { args: [], returns: v.object({}, "Rec", userStub) } },
  };
  return wrapServerTarget(target, validator) as { getUsers(): Record<string, { getName(): unknown }> };
}

describe("Record / index-signature stub values are wrapped", () => {
  it("validates a pipelined call through a dynamic-key stub value", () => {
    // The dynamic-key stub lies: getName returns a number, not a string.
    const rec = service({ getUsers: () => ({ alice: { getName: () => 12345 } }) }).getUsers();
    expect(() => rec.alice.getName()).toThrow(TypeError);
  });

  it("passes a correct dynamic-key stub value through", () => {
    const rec = service({ getUsers: () => ({ bob: { getName: () => "ok" } }) }).getUsers();
    expect(rec.bob.getName()).toBe("ok");
  });

  it("wraps multiple dynamic keys independently", () => {
    const rec = service({
      getUsers: () => ({
        good: { getName: () => "ok" },
        bad: { getName: () => 99 },
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
    const wrapped = wrapServerTarget(
      { m: () => ({ fixed: { getName: () => 1 }, dyn: { getName: () => "ok" } }) },
      validator,
    ) as { m(): Record<string, { getName(): unknown }> };
    const rec = wrapped.m();
    expect(() => rec.fixed.getName()).toThrow(TypeError); // fixed still validated
    expect(rec.dyn.getName()).toBe("ok"); // index still validated
  });
});
