// Branded primitives (`string & { __brand }`) must collapse to their underlying
// primitive, not be walked as objects (which would reject brand/.toString fields).
import { describe, it, expect } from "vitest";
import {
  accepts,
  checkedMethod,
  loadValidator,
  transformFixture,
  transformError,
} from "./helpers.js";
import { v } from "../src/internal/core.js";

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
  async getUser(id: UserId): Promise<string> {
    return id;
  }
}`
    );
    const getUser = checkedMethod(loadValidator(code), "getUser");
    expect(getUser.args[0]).toBe(v.string);
    expect(getUser.returns).toBe(v.string);
    expect(accepts(getUser.args[0]!, "u1")).toBe(true);
    expect(accepts(getUser.args[0]!, { toString: () => "u1" })).toBe(false);
  });

  it("validates a string-literal-branded string as v.string", () => {
    const code = emitFor(
      `type OrderId = string & { readonly __brand: "OrderId" };
class Api extends RpcTarget {
  async getOrder(id: OrderId): Promise<string> {
    return id;
  }
}`
    );
    const getOrder = checkedMethod(loadValidator(code), "getOrder");
    expect(getOrder.args[0]).toBe(v.string);
  });

  it("validates a branded number as v.number", () => {
    const code = emitFor(
      `type Cents = number & { readonly __brand: unique symbol };
class Api extends RpcTarget {
  async charge(amount: Cents): Promise<void> {}
}`
    );
    const charge = checkedMethod(loadValidator(code), "charge");
    expect(charge.args[0]).toBe(v.number);
  });

  it("still merges a genuine object intersection into an object shape", () => {
    // No primitive constituent -> must keep walking as an object so both halves
    // of the intersection are validated.
    const code = emitFor(
      `interface HasId {
  id: string;
}
interface HasName {
  name: string;
}
class Api extends RpcTarget {
  async save(v: HasId & HasName): Promise<void> {}
}`
    );
    const save = checkedMethod(loadValidator(code), "save");
    expect(accepts(save.args[0]!, { id: "u1", name: "Ada" })).toBe(true);
    expect(accepts(save.args[0]!, { id: "u1" })).toBe(false);
    expect(accepts(save.args[0]!, { name: "Ada" })).toBe(false);
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
