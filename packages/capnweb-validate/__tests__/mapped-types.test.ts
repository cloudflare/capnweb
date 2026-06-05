// Non-homomorphic mapped types materialize members synthetically, so their property
// symbols carry no declaration. A prior version dropped declaration-less properties,
// emitting an empty v.object({}) that validates nothing. Pin a real validator per key.
import { describe, it, expect } from "vitest";
import { transformFixture, prelude } from "./helpers.js";

function emitFor(body: string): string {
  return prelude(transformFixture(body, { target: "new Api()" }).code);
}

describe("non-homomorphic mapped types", () => {
  it("validates each key of a Record with a literal-union key", () => {
    const validator = emitFor(
      `type M = Record<"a" | "b", number>;
       class Api extends RpcTarget {
         async get(): Promise<M> { return null as any; }
       }`
    );
    // Each synthesized key must get its own validator, not an empty object.
    expect(validator).toContain(
      `__cw.v.object({ "a": __cw.v.number, "b": __cw.v.number }, "M")`
    );
    expect(validator).not.toMatch(/v\.object\(\{\s*\},\s*"M"\)/);
  });

  it("validates a permission-map shape (the common dangerous case)", () => {
    const validator = emitFor(
      `class Api extends RpcTarget {
         async get(): Promise<Record<"read" | "write" | "admin", boolean>> { return null as any; }
       }`
    );
    expect(validator).toContain(
      `__cw.v.object({ "read": __cw.v.boolean, "write": __cw.v.boolean, "admin": __cw.v.boolean }, "Record")`
    );
  });

  it("validates the literal-union mapped-type form `{ [K in U]: V }`", () => {
    const validator = emitFor(
      `class Api extends RpcTarget {
         async get(): Promise<{ [K in "x" | "y"]: string }> { return null as any; }
       }`
    );
    expect(validator).toContain(`"x": __cw.v.string`);
    expect(validator).toContain(`"y": __cw.v.string`);
    expect(validator).not.toMatch(/v\.object\(\{\s*\}\)/);
  });

  it("still resolves homomorphic mapped types over a named interface (no regression)", () => {
    const validator = emitFor(
      `interface Src { a: number; b: string }
       type M = { [K in keyof Src]: Src[K] };
       class Api extends RpcTarget {
         async get(): Promise<M> { return null as any; }
       }`
    );
    expect(validator).toContain(
      `__cw.v.object({ "a": __cw.v.number, "b": __cw.v.string }, "M")`
    );
  });
});
