// Non-homomorphic mapped types materialize members synthetically, so their property
// symbols carry no declaration. A prior version dropped declaration-less properties,
// emitting an empty v.object({}) that validates nothing. Pin a real validator per key.
import { describe, it, expect } from "vitest";
import {
  accepts,
  checkedMethod,
  loadValidator,
  transformFixture,
} from "./helpers.js";
import type { Validator } from "../src/internal/core.js";

function returnValidator(body: string): Validator {
  const code = transformFixture(body, { target: "new Api()" }).code;
  return checkedMethod(loadValidator(code), "get").returns;
}

describe("non-homomorphic mapped types", () => {
  it("validates each key of a Record with a literal-union key", () => {
    const validator = returnValidator(
      `type M = Record<"a" | "b", number>;
class Api extends RpcTarget {
  async get(): Promise<M> {
    return null as any;
  }
}`
    );
    expect(accepts(validator, { a: 1, b: 2 })).toBe(true);
    expect(accepts(validator, { a: 1 })).toBe(false);
    expect(accepts(validator, { a: 1, b: "x" })).toBe(false);
  });

  it("validates a permission-map shape (the common dangerous case)", () => {
    const validator = returnValidator(
      `class Api extends RpcTarget {
  async get(): Promise<Record<"read" | "write" | "admin", boolean>> {
    return null as any;
  }
}`
    );
    expect(accepts(validator, { read: true, write: false, admin: true })).toBe(
      true
    );
    expect(accepts(validator, { read: true, write: false })).toBe(false);
    expect(accepts(validator, { read: true, write: false, admin: "yes" })).toBe(
      false
    );
  });

  it("validates the literal-union mapped-type form `{ [K in U]: V }`", () => {
    const validator = returnValidator(
      `class Api extends RpcTarget {
  async get(): Promise<{ [K in "x" | "y"]: string }> {
    return null as any;
  }
}`
    );
    expect(accepts(validator, { x: "ok", y: "ok" })).toBe(true);
    expect(accepts(validator, { x: "ok" })).toBe(false);
    expect(accepts(validator, { x: "ok", y: 1 })).toBe(false);
  });

  it("still resolves homomorphic mapped types over a named interface (no regression)", () => {
    const validator = returnValidator(
      `interface Src {
  a: number;
  b: string;
}
type M = {
  [K in keyof Src]: Src[K];
};
class Api extends RpcTarget {
  async get(): Promise<M> {
    return null as any;
  }
}`
    );
    expect(accepts(validator, { a: 1, b: "ok" })).toBe(true);
    expect(accepts(validator, { a: "x", b: "ok" })).toBe(false);
    expect(accepts(validator, { a: 1 })).toBe(false);
  });
});
