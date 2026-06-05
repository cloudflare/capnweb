// Keys cross the wire as strings, so numeric index signatures need their value
// validator emitted too; a prior version dropped it and accepted any object.
import { describe, it, expect } from "vitest";
import { transformFixture, prelude } from "./helpers.js";

function emitFor(body: string): string {
  return prelude(transformFixture(body, { target: "new Api()" }).code);
}

describe("numeric index signatures", () => {
  it("validates values of a numeric-keyed Record (not a no-op object)", () => {
    const validator = emitFor(
      `interface V { id: string }
       class Api extends RpcTarget {
         async get(): Promise<Record<number, V>> { return null as any; }
       }`
    );
    // Third argument to v.object is the index validator. It must be present
    // and carry the value shape, not be dropped.
    expect(validator).toMatch(
      /v\.object\(\{\s*\},\s*"Record",\s*__cw\.v\.object\(\{\s*"id":\s*__cw\.v\.string\s*\},\s*"V"\)\)/
    );
  });

  it("validates values of a numeric index signature", () => {
    const validator = emitFor(
      `class Api extends RpcTarget {
         async get(): Promise<{ [k: number]: string }> { return null as any; }
       }`
    );
    expect(validator).toMatch(/v\.object\(\{\s*\},\s*undefined,\s*__cw\.v\.string\)/);
  });

  it("still validates string-keyed records (no regression)", () => {
    const validator = emitFor(
      `class Api extends RpcTarget {
         async get(): Promise<Record<string, number>> { return null as any; }
       }`
    );
    expect(validator).toMatch(/v\.object\(\{\s*\},\s*"Record",\s*__cw\.v\.number\)/);
  });
});
