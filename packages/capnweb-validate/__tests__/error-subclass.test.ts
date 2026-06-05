// Error subclasses go through the error wire path, so they must lower to v.error, not a structural v.object.
import { describe, it, expect } from "vitest";
import {
  accepts,
  checkedMethod,
  loadValidator,
  transformFixture,
} from "./helpers.js";
import { v } from "../src/internal/core.js";

function validatorFor(body: string) {
  return loadValidator(transformFixture(body, { target: "new Api()" }).code);
}

describe("Error subclass lowering", () => {
  it("lowers a user-defined Error subclass to v.error, not a structural object", () => {
    const validator = validatorFor(
      `class AppError extends Error {
  code = 1;
}
class Api extends RpcTarget {
  async get(): Promise<AppError> {
    return null as any;
  }
}`
    );
    const get = checkedMethod(validator, "get");
    expect(get.returns).toBe(v.error);
    expect(accepts(get.returns, new Error("x"))).toBe(true);
    expect(accepts(get.returns, { code: 1, stack: "x" })).toBe(false);
  });

  it("lowers a deep subclass chain to v.error", () => {
    const validator = validatorFor(
      `class A extends Error {}
class B extends A {}
class C extends B {}
class Api extends RpcTarget {
  async get(): Promise<C> {
    return null as any;
  }
}`
    );
    expect(checkedMethod(validator, "get").returns).toBe(v.error);
  });

  it("still lowers the global Error and standard subclasses to v.error", () => {
    const validator = validatorFor(
      `class Api extends RpcTarget {
  async a(): Promise<Error> {
    return null as any;
  }
  async b(): Promise<TypeError> {
    return null as any;
  }
}`
    );
    expect(checkedMethod(validator, "a").returns).toBe(v.error);
    expect(checkedMethod(validator, "b").returns).toBe(v.error);
  });

  it("does not hijack a user type merely named Error that is not the global", () => {
    // A locally-declared `Error`-named interface (not the lib global) is plain data.
    const validator = validatorFor(
      `interface Error {
  kind: string;
  detail: string;
}
class Api extends RpcTarget {
  async get(): Promise<Error> {
    return null as any;
  }
}`
    );
    const get = checkedMethod(validator, "get");
    expect(get.returns).not.toBe(v.error);
    expect(accepts(get.returns, { kind: "custom", detail: "x" })).toBe(true);
    expect(accepts(get.returns, new Error("x"))).toBe(false);
  });
});
