// Free class type params the decorator can't specialize: unconstrained defaults to any (warn), constrained validates the constraint, generic methods still error.
import { describe, it, expect } from "vitest";
import { DECORATOR_SHIM, transformFixture } from "./helpers.js";

const IMPORTS =
  `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";\n` +
  `import { skipRpcValidation, validateRpc } from "capnweb-validate";\n` +
  `import { RpcTarget } from "capnweb";\n`;

function compile(body: string, ctor: string): { code: string | null; warns: string[]; error?: string } {
  try {
    const { code, warns } = transformFixture(body, { shim: DECORATOR_SHIM, imports: IMPORTS, target: ctor });
    return { code, warns };
  } catch (e) {
    return { code: null, warns: [], error: e instanceof Error ? e.message : String(e) };
  }
}

describe("generic service classes", () => {
  it("keeps public class methods outside a single implemented interface", () => {
    const { code, warns } = compile(
      `interface A { a(): Promise<string>; }\n@validateRpc()\nclass Api extends RpcTarget implements A { async a(): Promise<string> { return ""; } async extra(x: number): Promise<number> { return x; } }`,
      "new Api()");
    expect(code).toContain('"a": { args: [], returns: __cw.v.string }');
    expect(code).toContain('"extra": { args: [__cw.v.number], returns: __cw.v.number }');
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("uses a single implemented interface to sharpen matching method signatures", () => {
    const { code, warns } = compile(
      `interface A { a(x: string): Promise<string>; }\n@validateRpc()\nclass Api extends RpcTarget implements A { async a(x: any): Promise<any> { return x; } async extra(x: number): Promise<number> { return x; } }`,
      "new Api()");
    expect(code).toContain('"a": { args: [__cw.v.string], returns: __cw.v.string }');
    expect(code).toContain('"extra": { args: [__cw.v.number], returns: __cw.v.number }');
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("defaults an unconstrained class type parameter to any, with a warning", () => {
    const { code, warns } = compile(
      `interface Cursor<T> { next(): Promise<T>; }\n@validateRpc()\nclass Api<T> extends RpcTarget implements Cursor<T> { async next(): Promise<T> { return null as any; } }`,
      "new Api()");
    expect(code).toContain('"next": { args: [], returns: __cw.v.any }');
    expect(warns.join("")).toContain("unconstrained type parameters default to `any`");
  });

  it("validates against the constraint for a constrained parameter, with no warning", () => {
    const { code, warns } = compile(
      `interface Cursor<T> { next(): Promise<T>; }\n@validateRpc()\nclass Api<T extends { id: string }> extends RpcTarget implements Cursor<T> { async next(): Promise<T> { return null as any; } }`,
      "new Api<{ id: string }>()");
    expect(code).toMatch(/next[\s\S]*returns:\s*__cw\.v\.object\(\{\s*"id":\s*__cw\.v\.string\s*\}\)/);
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("uses an explicit decorator type argument to specialize matching class methods only", () => {
    const { code, warns } = compile(
      `interface Cursor<T> { next(): Promise<T>; }\n@validateRpc<Cursor<string>>()\nclass Api<T> extends RpcTarget implements Cursor<T> { async next(): Promise<T> { return null as any; } async extra(x: number): Promise<number> { return x; } }`,
      "new Api<string>()");
    expect(code).toContain('"next": { args: [], returns: __cw.v.string }');
    expect(code).toContain('"extra": { args: [__cw.v.number], returns: __cw.v.number }');
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("does not let an explicit method signature turn a getter into a method", () => {
    const { code } = compile(
      `interface Sig { config(): Promise<string>; }\n@validateRpc<Sig>()\nclass Api extends RpcTarget { get config(): Promise<string> { return Promise.resolve("ok"); } }`,
      "new Api()");
    expect(code).toMatch(/"config":\s*\{ args: \[\], returns: __cw\.v\.string, isGetter: true \}/);
  });

  it("does not let an explicit getter signature turn a method into a getter", () => {
    const { code } = compile(
      `interface Sig { value: string; }\n@validateRpc<Sig>()\nclass Api extends RpcTarget { value(): string { return "ok"; } }`,
      "new Api()");
    expect(code).toMatch(/"value":\s*\{ args: \[\], returns: __cw\.v\.string \}/);
    expect(code).not.toMatch(/"value"[\s\S]*isGetter: true/);
  });

  it("keeps an overloaded explicit signature unchecked for a callable class method", () => {
    const { code } = compile(
      `interface Sig { foo(): Promise<string>; foo(x: string): Promise<string>; }\n@validateRpc<Sig>()\nclass Api extends RpcTarget { async foo(x?: any): Promise<any> { return ""; } }`,
      "new Api()");
    expect(code).toContain('"foo": { unchecked: true }');
  });

  it("does not warn for an overloaded explicit signature when the class method is skipped", () => {
    const { code, warns } = compile(
      `interface Sig { foo(x: string): Promise<string>; foo(x: number): Promise<number>; }\n@validateRpc<Sig>()\nclass Api extends RpcTarget { @skipRpcValidation() async foo(x: any): Promise<any> { return x; } }`,
      "new Api()");
    expect(code).toContain('"foo": { unchecked: true }');
    expect(warns.join("")).not.toContain("overloaded");
  });

  it("ignores explicit signature members outside the class surface", () => {
    const { code, warns } = compile(
      `interface Sig { extra(): Promise<string>; extra(x: string): Promise<string>; }\n@validateRpc<Sig>()\nclass Api extends RpcTarget { ok(): string { return "ok"; } }`,
      "new Api()");
    expect(code).toContain('"ok": { args: [], returns: __cw.v.string }');
    expect(code).not.toContain('"extra"');
    expect(warns.join("")).not.toContain("overloaded");
  });

  it("does not resolve explicit signature members matching non-RPC class fields", () => {
    const { code, warns } = compile(
      `interface Sig { field(): Promise<string>; field(x: string): Promise<string>; }\n@validateRpc<Sig>()\nclass Api extends RpcTarget { field = 1; ok(): string { return "ok"; } }`,
      "new Api()");
    expect(code).toContain('"ok": { args: [], returns: __cw.v.string }');
    expect(code).not.toContain('"field"');
    expect(warns.join("")).not.toContain("overloaded");
  });

  it("does not warn when an overloaded signature name is a class getter", () => {
    const { code, warns } = compile(
      `interface Sig { foo(): Promise<string>; foo(x: string): Promise<string>; }\n@validateRpc<Sig>()\nclass Api extends RpcTarget { get foo(): Promise<string> { return Promise.resolve("ok"); } }`,
      "new Api()");
    expect(code).toMatch(/"foo":\s*\{ args: \[\], returns: __cw\.v\.string, isGetter: true \}/);
    expect(warns.join("")).not.toContain("overloaded");
  });

  it("does not reuse a filtered signature source for nested stub validation", () => {
    const { code } = compile(
      `type RpcStub<T> = T & { readonly __RPC_STUB_BRAND: T };\ninterface Sig { a(): Promise<string>; admin(): Promise<number>; }\n@validateRpc<Sig>()\nclass Api extends RpcTarget { a(): Promise<string> { return Promise.resolve(""); } peer(p: RpcStub<Sig>): Promise<void> { return Promise.resolve(); } }`,
      "new Api()");
    expect(code).toContain('"a": { args: [], returns: __cw.v.string }');
    expect(code).toContain('"peer": { args: [__cw.v.stubOf(');
    expect(code).toContain('"admin": { args: [], returns: __cw.v.number }');
  });

  it("resolves a class with multiple implemented interfaces via the class surface", () => {
    const { code, warns } = compile(
      `interface A { a(): Promise<string>; }\ninterface B { b(): Promise<number>; }\n@validateRpc()\nclass Api extends RpcTarget implements A, B { async a(): Promise<string> { return ""; } async b(): Promise<number> { return 0; } }`,
      "new Api()");
    expect(code).toContain('"a": { args: [], returns: __cw.v.string }');
    expect(code).toContain('"b": { args: [], returns: __cw.v.number }');
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("still errors on a generic method, because no class type argument can fix it", () => {
    const { code, error } = compile(
      `@validateRpc()\nclass Api extends RpcTarget { async get<T>(x: T): Promise<T> { return null as any; } }`,
      "new Api()");
    expect(code).toBeNull();
    expect(error).toContain("unresolved generic type parameter");
  });
});
