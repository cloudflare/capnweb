// Overloaded methods pass through unvalidated (with a warning) since validating
// against only the first signature would reject valid calls to other overloads.
import { describe, it, expect } from "vitest";
import {
  checkedMethod,
  DECORATOR_SHIM,
  loadValidator,
  transformFixture,
} from "./helpers.js";
import { v } from "../src/internal/core.js";

const IMPORTS = `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { RpcTarget } from "capnweb";
`;

function compile(body: string): { code: string; warns: string[] } {
  return transformFixture(body, {
    shim: DECORATOR_SHIM,
    imports: IMPORTS,
    target: "new Api()",
  });
}

describe("method overloads", () => {
  it("passes an overloaded method through unvalidated with a single warning", () => {
    const { code, warns } = compile(
      `@validateRpc()
class Api extends RpcTarget {
  foo(x: string): Promise<string>;
  foo(x: number): Promise<number>;
  async foo(x: any): Promise<any> {
    return x;
  }
}`);
    // unchecked, NOT validated against the first (string) signature
    expect(loadValidator(code).methods.foo).toEqual({ unchecked: true });
    // warned exactly once despite decorator + call-site both resolving Api
    const overloadWarns = warns.filter((w) => w.includes("is overloaded"));
    expect(overloadWarns.length).toBe(1);
  });

  it("handles overloads that differ in arity", () => {
    const { code } = compile(
      `@validateRpc()
class Api extends RpcTarget {
  foo(): Promise<string>;
  foo(x: string): Promise<string>;
  async foo(x?: string): Promise<string> {
    return x ?? "";
  }
}`);
    expect(loadValidator(code).methods.foo).toEqual({ unchecked: true });
  });

  it("still validates a single-signature method (no false positive)", () => {
    const { code, warns } = compile(
      `@validateRpc()
class Api extends RpcTarget {
  async foo(x: string): Promise<string> {
    return x;
  }
}`);
    const foo = checkedMethod(loadValidator(code), "foo");
    expect(foo.args[0]).toBe(v.string);
    expect(foo.returns).toBe(v.string);
    expect(warns.filter((w) => w.includes("is overloaded")).length).toBe(0);
  });

  it("does not warn when the overloaded method is explicitly @skipRpcValidation", () => {
    const { code, warns } = compile(
      `@validateRpc()
class Api extends RpcTarget {
  @skipRpcValidation() foo(x: string): Promise<string>;
  @skipRpcValidation() foo(x: number): Promise<number>;
  async foo(x: any): Promise<any> {
    return x;
  }
}`);
    expect(loadValidator(code).methods.foo).toEqual({ unchecked: true });
    expect(warns.filter((w) => w.includes("is overloaded")).length).toBe(0);
  });

  it("does not warn when @skipRpcValidation is on the overload implementation", () => {
    const { code, warns } = compile(
      `@validateRpc()
class Api extends RpcTarget {
  foo(x: string): Promise<string>;
  foo(x: number): Promise<number>;
  @skipRpcValidation()
  async foo(x: any): Promise<any> {
    return x;
  }
}`);
    expect(loadValidator(code).methods.foo).toEqual({ unchecked: true });
    expect(warns.filter((w) => w.includes("is overloaded")).length).toBe(0);
  });
});
