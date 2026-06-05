// Regressions: optional methods (union with undefined reports no call signatures) were dropped, and unresolved generics leaked the raw TS flag bitmask.
import { describe, it, expect } from "vitest";
import { transformFixture } from "./helpers.js";

function build(body: string): { code: string; error?: string } {
  try {
    return { code: transformFixture(body, { target: "new Api()" }).code };
  } catch (e) {
    return { code: "", error: e instanceof Error ? e.message : String(e) };
  }
}

describe("method edge cases", () => {
  it("validates an optional method instead of dropping it", () => {
    const { code, error } = build(
      `class Api extends RpcTarget { ping?(x: string): Promise<string> { return null as any; } }`,
    );
    expect(error).toBeUndefined();
    // The optional method must appear in the validator with its arg + return
    // shape, not be silently omitted (which would reject a real call).
    expect(code).toMatch(/"ping":\s*\{\s*args:\s*\[__cw\.v\.string\],\s*returns:\s*__cw\.v\.string\s*\}/);
  });

  it("validates a required method alongside an optional one", () => {
    const { code, error } = build(
      `class Api extends RpcTarget {
         required(x: number): Promise<number> { return null as any; }
         optional?(y: string): Promise<string> { return null as any; }
       }`,
    );
    expect(error).toBeUndefined();
    expect(code).toContain('"required":');
    expect(code).toContain('"optional":');
  });

  it("reports an unresolved generic type parameter in human terms", () => {
    const { error } = build(
      `class Api extends RpcTarget { get<T>(x: T): Promise<T> { return null as any; } }`,
    );
    expect(error).toBeDefined();
    expect(error).toContain("unresolved generic type parameter");
    // Must not leak the raw TypeScript flag bitmask.
    expect(error).not.toMatch(/flags=\d/);
  });
});
