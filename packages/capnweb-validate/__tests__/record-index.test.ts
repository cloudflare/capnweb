// Keys cross the wire as strings, so numeric index signatures need their value
// validator emitted too; a prior version dropped it and accepted any object.
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

describe("numeric index signatures", () => {
  it("validates values of a numeric-keyed Record (not a no-op object)", () => {
    const validator = returnValidator(
      `interface V {
  id: string;
}
class Api extends RpcTarget {
  async get(): Promise<Record<number, V>> {
    return null as any;
  }
}`
    );
    expect(accepts(validator, { 1: { id: "u1" } })).toBe(true);
    expect(accepts(validator, { 1: { id: 123 } })).toBe(false);
    expect(accepts(validator, { 1: {} })).toBe(false);
  });

  it("validates values of a numeric index signature", () => {
    const validator = returnValidator(
      `class Api extends RpcTarget {
  async get(): Promise<{ [k: number]: string }> {
    return null as any;
  }
}`
    );
    expect(accepts(validator, { 1: "ok", 2: "also ok" })).toBe(true);
    expect(accepts(validator, { 1: "ok", 2: 123 })).toBe(false);
  });

  it("still validates string-keyed records (no regression)", () => {
    const validator = returnValidator(
      `class Api extends RpcTarget {
  async get(): Promise<Record<string, number>> {
    return null as any;
  }
}`
    );
    expect(accepts(validator, { a: 1, b: 2 })).toBe(true);
    expect(accepts(validator, { a: 1, b: "x" })).toBe(false);
  });
});
