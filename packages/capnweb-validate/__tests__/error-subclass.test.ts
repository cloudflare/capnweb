// Error subclasses go through the error wire path, so they must lower to v.error, not a structural v.object.
import { describe, it, expect } from "vitest";
import { transformFixture, prelude } from "./helpers.js";

function emitFor(body: string): string {
  return prelude(transformFixture(body, { target: "new Api()" }).code, "export function handler");
}

describe("Error subclass lowering", () => {
  it("lowers a user-defined Error subclass to v.error, not a structural object", () => {
    const code = emitFor(
      `class AppError extends Error { code = 1; }
       class Api extends RpcTarget { async get(): Promise<AppError> { return null as any; } }`
    );
    expect(code).toMatch(/"get":\s*\{\s*args:\s*\[\],\s*returns:\s*__cw\.v\.error\s*\}/);
    // Must not walk the error's own/inherited properties into an object validator.
    expect(code).not.toContain('"code"');
    expect(code).not.toContain('"stack"');
  });

  it("lowers a deep subclass chain to v.error", () => {
    const code = emitFor(
      `class A extends Error {}
       class B extends A {}
       class C extends B {}
       class Api extends RpcTarget { async get(): Promise<C> { return null as any; } }`
    );
    expect(code).toContain("returns: __cw.v.error");
  });

  it("still lowers the global Error and standard subclasses to v.error", () => {
    const code = emitFor(
      `class Api extends RpcTarget {
         async a(): Promise<Error> { return null as any; }
         async b(): Promise<TypeError> { return null as any; }
       }`
    );
    expect(code).toMatch(/"a":\s*\{\s*args:\s*\[\],\s*returns:\s*__cw\.v\.error\s*\}/);
    expect(code).toMatch(/"b":\s*\{\s*args:\s*\[\],\s*returns:\s*__cw\.v\.error\s*\}/);
  });

  it("does not hijack a user type merely named Error that is not the global", () => {
    // A locally-declared `Error`-named interface (not the lib global) is plain data.
    const code = emitFor(
      `interface Error { kind: string; detail: string; }
       class Api extends RpcTarget { async get(): Promise<Error> { return null as any; } }`
    );
    expect(code).toContain('"kind": __cw.v.string');
    expect(code).not.toContain("returns: __cw.v.error");
  });
});
