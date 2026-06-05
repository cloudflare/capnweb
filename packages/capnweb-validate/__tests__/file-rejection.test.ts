// Blob validates by exact prototype, so File (a Blob subclass) is categorized
// "unsupported". The transform must reject File at build time rather than emit
// v.blob, which would accept a subclass in a Blob-typed position. Blob itself
// stays supported.
import { describe, it, expect } from "vitest";
import { checkedMethod, loadValidator, transformFixture } from "./helpers.js";
import { v } from "../src/internal/core.js";

function accepts(validator: (value: unknown, path: never[]) => void, value: unknown): boolean {
  try {
    validator(value, []);
    return true;
  } catch (e) {
    if (e instanceof TypeError) return false;
    throw e;
  }
}

function build(body: string): { code: string; error?: string } {
  try {
    return { code: transformFixture(body, { target: "new Api()" }).code };
  } catch (e) {
    return { code: "", error: e instanceof Error ? e.message : String(e) };
  }
}

describe("File is rejected at build time", () => {
  it("rejects a File argument with a wire-type error and a fix hint", () => {
    const { error } = build(
      `class Api extends RpcTarget {
  async upload(f: File): Promise<void> {}
}`,
    );
    expect(error).toContain("Api.upload argument 1 is File");
    expect(error).toContain("not a supported RPC validation type");
    expect(error).toContain("Use a Blob or Uint8Array");
  });

  it("rejects a File nested in a returned object", () => {
    const { error } = build(
      `class Api extends RpcTarget {
  async get(): Promise<{ avatar: File }> {
    return null as any;
  }
}`,
    );
    expect(error).toContain("not a supported RPC validation type");
  });

  it("still accepts Blob (the supported base type)", () => {
    const { code, error } = build(
      `class Api extends RpcTarget {
  async get(): Promise<Blob> {
    return null as any;
  }
}`,
    );
    expect(error).toBeUndefined();
    expect(checkedMethod(loadValidator(code), "get").returns).toBe(v.blob);
  });
});

describe("exact-prototype brands reject subclasses", () => {
  it("v.blob rejects a Blob subclass (e.g. File) but accepts a real Blob", () => {
    class FileLike extends Blob {}
    expect(accepts(v.blob, new Blob(["x"]))).toBe(true);
    expect(accepts(v.blob, new FileLike(["x"]))).toBe(false);
  });

  it("v.date rejects a Date subclass but accepts a real Date", () => {
    class SubDate extends Date {}
    expect(accepts(v.date, new Date())).toBe(true);
    expect(accepts(v.date, new SubDate())).toBe(false);
  });

  it("v.bytes keeps accepting Buffer (capnweb allows it)", () => {
    // Buffer's prototype is not Uint8Array.prototype, but it is a Uint8Array
    // subclass, so the bytes validator stays instanceof, not exact-prototype.
    expect(accepts(v.bytes, new Uint8Array([1]))).toBe(true);
    expect(accepts(v.bytes, Buffer.from([1]))).toBe(true);
  });

  it("v.error keeps accepting Error subclasses (capnweb uses instanceof)", () => {
    class AppError extends Error {}
    expect(accepts(v.error, new Error("x"))).toBe(true);
    expect(accepts(v.error, new AppError("x"))).toBe(true);
  });

  it("exact-prototype brands reject null, undefined, and plain objects", () => {
    for (const bad of [null, undefined, {}, 42, "x"]) {
      expect(accepts(v.blob, bad)).toBe(false);
      expect(accepts(v.response, bad)).toBe(false);
    }
  });
});
