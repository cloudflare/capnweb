// Extra args past the declared parameter list are ignored, so a newer caller
// can pass a parameter this build's signature doesn't know about.
import { describe, it, expect } from "vitest";
import { checkedMethod, loadValidator, transformFixture } from "./helpers.js";
import {
  v,
  validateArgs,
  wrapServerTarget,
  type ServiceValidator,
} from "../src/internal/core.js";

function validator(body: string) {
  return loadValidator(transformFixture(body, { target: "new Api()" }).code);
}

describe("extra arguments", () => {
  it("ignores args beyond the declared parameters", () => {
    const spec = checkedMethod(
      validator(
        `class Api extends RpcTarget {
  greet(name: string): Promise<string> {
    return null as any;
  }
}`,
      ),
      "greet",
    );
    expect(() =>
      validateArgs(["bob", 123, { extra: true }], spec, "Api", "greet"),
    ).not.toThrow();
  });

  it("still validates the declared parameters", () => {
    const spec = checkedMethod(
      validator(
        `class Api extends RpcTarget {
  greet(name: string): Promise<string> {
    return null as any;
  }
}`,
      ),
      "greet",
    );
    expect(() => validateArgs([42, "ignored"], spec, "Api", "greet")).toThrow(
      TypeError,
    );
  });

  it("still validates extra args against a rest parameter", () => {
    const spec = checkedMethod(
      validator(
        `class Api extends RpcTarget {
  sum(label: string, ...values: number[]): Promise<number> {
    return null as any;
  }
}`,
      ),
      "sum",
    );
    expect(() => validateArgs(["a", 1, 2], spec, "Api", "sum")).not.toThrow();
    expect(() => validateArgs(["a", 1, "b"], spec, "Api", "sum")).toThrow(
      TypeError,
    );
  });
});

// Ignoring an extra arg means the implementation never sees it: a rest
// parameter or `arguments` would otherwise read a value no validator checked.
describe("extra arguments reaching the implementation", () => {
  function seen(validator: ServiceValidator, impl: (...a: unknown[]) => string) {
    const target = { greet: impl, sum: impl };
    return wrapServerTarget(target, validator) as Record<
      string,
      (...a: unknown[]) => string
    >;
  }

  it("drops undeclared args before invoking the method", () => {
    const rest: unknown[][] = [];
    const api = seen(
      { serviceName: "Api", methods: { greet: { args: [v.string], returns: v.string } } },
      (...args: unknown[]) => {
        rest.push(args);
        return "ok";
      },
    );
    expect(api.greet("bob", { steal: true })).toBe("ok");
    expect(rest).toEqual([["bob"]]);
  });

  it("keeps extra args a rest parameter declares and validates", () => {
    const rest: unknown[][] = [];
    const api = seen(
      {
        serviceName: "Api",
        methods: { sum: { args: [v.string], rest: v.number, returns: v.string } },
      },
      (...args: unknown[]) => {
        rest.push(args);
        return "ok";
      },
    );
    expect(api.sum("a", 1, 2)).toBe("ok");
    expect(rest).toEqual([["a", 1, 2]]);
    expect(() => api.sum("a", 1, "b")).toThrow(TypeError);
  });
});
