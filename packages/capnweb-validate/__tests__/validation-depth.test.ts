// The depth cap that bounds validator recursion must fail CLOSED: a value
// nested past the limit is rejected, not silently accepted unvalidated.
import { describe, it, expect } from "vitest";
import { v } from "../src/internal/core.js";

function nest<T>(times: number, wrap: (inner: T) => T, base: T): T {
  let out = base;
  for (let i = 0; i < times; i++) out = wrap(out);
  return out;
}

describe("validation depth limit", () => {
  it("rejects values nested beyond the max depth (fail closed)", () => {
    const validator = nest(70, v.array, v.number as ReturnType<typeof v.array>);
    const value = nest<unknown>(70, (inner) => [inner], 5);
    expect(() => validator(value, [])).toThrow(TypeError);
  });

  it("accepts well-typed values within the max depth", () => {
    const validator = nest(10, v.array, v.number as ReturnType<typeof v.array>);
    const value = nest<unknown>(10, (inner) => [inner], 5);
    expect(() => validator(value, [])).not.toThrow();
  });

  it("still rejects a wrong leaf within the max depth", () => {
    const validator = nest(10, v.array, v.number as ReturnType<typeof v.array>);
    const value = nest<unknown>(10, (inner) => [inner], "not-a-number");
    expect(() => validator(value, [])).toThrow(TypeError);
  });
});
