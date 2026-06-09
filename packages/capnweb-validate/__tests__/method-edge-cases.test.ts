// Regressions: optional methods (union with undefined reports no call signatures) were dropped, and unresolved generics leaked the raw TS flag bitmask.
import { describe, it, expect } from "vitest";
import {
  accepts,
  checkedMethod,
  loadValidator,
  transformFixture,
} from "./helpers.js";
import { v } from "../src/internal/core.js";

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
      `class Api extends RpcTarget {
  ping?(x: string): Promise<string> {
    return null as any;
  }
}`,
    );
    expect(error).toBeUndefined();
    // The optional method must appear in the validator with its arg + return
    // shape, not be silently omitted (which would reject a real call).
    const ping = checkedMethod(loadValidator(code), "ping");
    expect(ping.args[0]).toBe(v.string);
    expect(ping.returns).toBe(v.string);
  });

  it("validates a required method alongside an optional one", () => {
    const { code, error } = build(
      `class Api extends RpcTarget {
  required(x: number): Promise<number> {
    return null as any;
  }
  optional?(y: string): Promise<string> {
    return null as any;
  }
}`,
    );
    expect(error).toBeUndefined();
    const validator = loadValidator(code);
    expect(Object.keys(validator.methods)).toEqual(["required", "optional"]);
    expect(checkedMethod(validator, "required").returns).toBe(v.number);
    expect(checkedMethod(validator, "optional").returns).toBe(v.string);
  });

  it("allows undefined for optional parameters when strictNullChecks is off", () => {
    const { code } = transformFixture(
      `class Api extends RpcTarget {
  ping(x?: string): Promise<string> {
    return null as any;
  }
}`,
      {
        target: "new Api()",
        compilerOptions: { strictNullChecks: false },
      }
    );
    const ping = checkedMethod(loadValidator(code), "ping");
    expect(accepts(ping.args[0]!, undefined)).toBe(true);
    expect(accepts(ping.args[0]!, "ok")).toBe(true);
    expect(accepts(ping.args[0]!, 1)).toBe(false);
  });

  it("allows undefined for default-initialized parameters", () => {
    const { code } = transformFixture(
      `class Api extends RpcTarget {
  ping(x = "default"): Promise<string> {
    return null as any;
  }
}`,
      { target: "new Api()" }
    );
    const ping = checkedMethod(loadValidator(code), "ping");
    expect(accepts(ping.args[0]!, undefined)).toBe(true);
    expect(accepts(ping.args[0]!, "ok")).toBe(true);
    expect(accepts(ping.args[0]!, 1)).toBe(false);
  });

  it("reports an unresolved generic type parameter in human terms", () => {
    const { error } = build(
      `class Api extends RpcTarget {
  get<T>(x: T): Promise<T> {
    return null as any;
  }
}`,
    );
    expect(error).toBeDefined();
    expect(error).toContain("unresolved generic type parameter");
    // Must not leak the raw TypeScript flag bitmask.
    expect(error).not.toContain("flags=");
  });
});
