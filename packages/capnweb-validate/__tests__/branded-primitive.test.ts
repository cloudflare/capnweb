// Branded primitives (`string & { __brand }`) must collapse to their underlying
// primitive, not be walked as objects (which would reject brand/.toString fields).
import { describe, it, expect } from "vitest";
import { transformFixture, transformError } from "./helpers.js";

function emitFor(body: string): string {
  return transformFixture(body, { target: "new Api()" }).code;
}

function buildError(body: string): string {
  return transformError(body, { target: "new Api()" });
}

describe("branded primitives", () => {
  it("validates a symbol-branded string as v.string", () => {
    const code = emitFor(
      `type UserId = string & { readonly __brand: unique symbol };
       class Api extends RpcTarget {
         async getUser(id: UserId): Promise<string> { return id; }
       }`
    );
    // Assert against the emitted validator only; source (incl. `type UserId`) is kept verbatim.
    expect(code).toMatch(/getUser[\s\S]*?args:\s*\[\s*__rt\.v\.string\s*\]/);
    const validator = code.slice(0, code.indexOf("class Api"));
    expect(validator).not.toContain("toString");
    expect(validator).not.toContain("v.object");
  });

  it("validates a string-literal-branded string as v.string", () => {
    const code = emitFor(
      `type OrderId = string & { readonly __brand: "OrderId" };
       class Api extends RpcTarget {
         async getOrder(id: OrderId): Promise<string> { return id; }
       }`
    );
    expect(code).toMatch(/getOrder[\s\S]*args:\s*\[\s*__rt\.v\.string\s*\]/);
  });

  it("validates a branded number as v.number", () => {
    const code = emitFor(
      `type Cents = number & { readonly __brand: unique symbol };
       class Api extends RpcTarget {
         async charge(amount: Cents): Promise<void> {}
       }`
    );
    expect(code).toMatch(/charge[\s\S]*args:\s*\[\s*__rt\.v\.number\s*\]/);
  });

  it("still merges a genuine object intersection into an object shape", () => {
    // No primitive constituent -> must keep walking as an object so both halves
    // of the intersection are validated.
    const code = emitFor(
      `interface HasId { id: string }
       interface HasName { name: string }
       class Api extends RpcTarget {
         async save(v: HasId & HasName): Promise<void> {}
       }`
    );
    expect(code).toMatch(/"id":\s*__rt\.v\.string/);
    expect(code).toMatch(/"name":\s*__rt\.v\.string/);
  });

  it("still rejects a genuinely unsupported type in a property position", () => {
    // The primitive-collapse must not weaken rejection elsewhere: a `WeakMap`
    // property still fails the build loudly.
    const msg = buildError(
      `class Api extends RpcTarget {
         async save(v: { data: WeakMap<object, number> }): Promise<void> {}
       }`
    );
    expect(msg).toContain("capnweb-validate");
  });
});
