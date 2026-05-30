// Free class type params the decorator can't specialize: unconstrained defaults to any (warn), constrained validates the constraint, generic methods still error.
import { describe, it, expect } from "vitest";
import { DECORATOR_SHIM, transformFixture } from "./helpers.js";

const IMPORTS =
  `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";\n` +
  `import { validateRpc } from "capnweb-validate";\n` +
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
  it("defaults an unconstrained class type parameter to any, with a warning", () => {
    const { code, warns } = compile(
      `interface Cursor<T> { next(): Promise<T>; }\n@validateRpc()\nclass Api<T> extends RpcTarget implements Cursor<T> { async next(): Promise<T> { return null as any; } }`,
      "new Api()");
    expect(code).toContain('"next": { args: [], returns: __rt.v.any }');
    expect(warns.join("")).toContain("unconstrained type parameters default to `any`");
  });

  it("validates against the constraint for a constrained parameter, with no warning", () => {
    const { code, warns } = compile(
      `interface Cursor<T> { next(): Promise<T>; }\n@validateRpc()\nclass Api<T extends { id: string }> extends RpcTarget implements Cursor<T> { async next(): Promise<T> { return null as any; } }`,
      "new Api<{ id: string }>()");
    expect(code).toMatch(/next[\s\S]*returns:\s*__rt\.v\.object\(\{\s*"id":\s*__rt\.v\.string\s*\}\)/);
    expect(warns.join("")).not.toContain("unconstrained");
  });

  it("resolves a class with multiple implemented interfaces via the class surface", () => {
    const { code, warns } = compile(
      `interface A { a(): Promise<string>; }\ninterface B { b(): Promise<number>; }\n@validateRpc()\nclass Api extends RpcTarget implements A, B { async a(): Promise<string> { return ""; } async b(): Promise<number> { return 0; } }`,
      "new Api()");
    expect(code).toContain('"a": { args: [], returns: __rt.v.string }');
    expect(code).toContain('"b": { args: [], returns: __rt.v.number }');
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
