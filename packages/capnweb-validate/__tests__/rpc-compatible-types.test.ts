import { describe, it, expect } from "vitest";
import {
  accepts,
  checkedMethod,
  loadValidator,
  transformFixture,
  transformError,
} from "./helpers.js";
import { v } from "../src/internal/core.js";

describe("RPC-compatible value types", () => {
  it("accepts ArrayBuffer, DataView, RegExp, Map/Set, and typed arrays at build time", () => {
    const { code } = transformFixture(
      `class Api extends RpcTarget {
  async roundTrip(
    buffer: ArrayBuffer,
    view: DataView,
    ints: Int16Array,
    pattern: RegExp,
    bytes: Uint8Array,
  ): Promise<Map<string, Set<Float32Array>>> {
    return null as any;
  }
}`,
      { target: "new Api()" }
    );
    const roundTrip = checkedMethod(loadValidator(code), "roundTrip");
    expect(accepts(roundTrip.args[0]!, new ArrayBuffer(1))).toBe(true);
    expect(accepts(roundTrip.args[1]!, new DataView(new ArrayBuffer(1)))).toBe(
      true
    );
    expect(accepts(roundTrip.args[2]!, new Int16Array(1))).toBe(true);
    expect(accepts(roundTrip.args[3]!, /ok/u)).toBe(true);
    expect(accepts(roundTrip.args[4]!, new Uint8Array(1))).toBe(true);
    expect(accepts(roundTrip.args[0]!, new Uint8Array(1))).toBe(false);
    expect(accepts(roundTrip.args[1]!, new Uint8Array(1))).toBe(false);
    expect(accepts(roundTrip.args[2]!, new Uint8Array(1))).toBe(false);
    expect(accepts(roundTrip.args[3]!, "ok")).toBe(false);
    expect(accepts(roundTrip.args[4]!, new ArrayBuffer(1))).toBe(false);

    expect(
      accepts(
        roundTrip.returns,
        new Map([["ok", new Set([new Float32Array(1)])]])
      )
    ).toBe(true);
    expect(
      accepts(roundTrip.returns, new Map([[1, new Set([new Float32Array(1)])]]))
    ).toBe(false);
    expect(
      accepts(roundTrip.returns, new Map([["ok", new Set([new Int16Array(1)])]]))
    ).toBe(false);
  });

  it("lowers ReadonlyMap and ReadonlySet to Map/Set runtime validators", () => {
    const { code } = transformFixture(
      `class Api extends RpcTarget {
  getConfig(): ReadonlyMap<string, ReadonlySet<number>> {
    return null as any;
  }
}`,
      { target: "new Api()" }
    );
    const getConfig = checkedMethod(loadValidator(code), "getConfig");
    expect(accepts(getConfig.returns, new Map([["ok", new Set([1])]]))).toBe(
      true
    );
    expect(accepts(getConfig.returns, new Map([[1, new Set([1])]]))).toBe(
      false
    );
    expect(accepts(getConfig.returns, new Map([["ok", new Set(["x"])]]))).toBe(
      false
    );
  });

  it("rejects non-cloneable collection types at build time", () => {
    const msg = transformError(
      `class Api extends RpcTarget {
  async m(): Promise<Map<string, WeakSet<object>>> {
    return null as any;
  }
}`,
      { target: "new Api()" }
    );
    expect(msg).toContain("WeakSet");
    expect(msg).toContain("<value>");
    expect(msg).toContain("not a supported RPC validation type");
  });

  it("rejects explicit SharedArrayBuffer-backed views at build time", () => {
    const msg = transformError(
      `class Api extends RpcTarget {
  setBytes(value: Int16Array<SharedArrayBuffer>): void {}
}`,
      { target: "new Api()" }
    );
    expect(msg).toContain("Int16Array<SharedArrayBuffer>");
    expect(msg).toContain("backed by SharedArrayBuffer");
  });

  it("rejects explicit union view backing types that include SharedArrayBuffer", () => {
    const msg = transformError(
      `type Backing = ArrayBuffer | SharedArrayBuffer;
class Api extends RpcTarget {
  setBytes(value: Int16Array<Backing>): void {}
}`,
      { target: "new Api()" }
    );
    expect(msg).toContain("Int16Array<Backing>");
    expect(msg).toContain("backed by SharedArrayBuffer");
  });

  it("rejects generic view backing constraints that include SharedArrayBuffer", () => {
    const msg = transformError(
      `class Api extends RpcTarget {
  setBytes<T extends ArrayBuffer | SharedArrayBuffer>(value: Int16Array<T>): void {}
}`,
      { target: "new Api()" }
    );
    expect(msg).toContain("Int16Array<T>");
    expect(msg).toContain("backed by SharedArrayBuffer");
  });

  it("keeps ArrayBuffer and Uint8Array runtime validators distinct", () => {
    expect(accepts(v.arrayBuffer, new ArrayBuffer(4))).toBe(true);
    expect(accepts(v.arrayBuffer, new Uint8Array(4))).toBe(false);
    expect(accepts(v.bytes, new Uint8Array(4))).toBe(true);
    expect(accepts(v.bytes, new ArrayBuffer(4))).toBe(false);
  });

  it("validates RPC-compatible built-in brands at runtime", () => {
    expect(accepts(v.dataView, new DataView(new ArrayBuffer(4)))).toBe(true);
    expect(accepts(v.dataView, new Uint8Array(4))).toBe(false);
    expect(accepts(v.regexp, /abc/u)).toBe(true);
    expect(accepts(v.regexp, "abc")).toBe(false);

    const int16 = v.typedArray("Int16Array");
    expect(accepts(int16, new Int16Array(2))).toBe(true);
    expect(accepts(int16, new Uint8Array(2))).toBe(false);
  });

  it("rejects views backed by SharedArrayBuffer at runtime", () => {
    if (typeof SharedArrayBuffer !== "function") return;
    const buffer = new SharedArrayBuffer(8);
    expect(accepts(v.bytes, new Uint8Array(buffer))).toBe(false);
    expect(accepts(v.dataView, new DataView(buffer))).toBe(false);
    expect(accepts(v.typedArray("Int16Array"), new Int16Array(buffer))).toBe(false);
  });

  it("validates Map keys and values at runtime", () => {
    const validator = v.map(v.string, v.set(v.number));
    expect(accepts(validator, new Map([["ok", new Set([1, 2])]]))).toBe(true);
    expect(accepts(validator, new Map([[1, new Set([2])]]))).toBe(false);
    expect(accepts(validator, new Map([["bad", new Set(["x"])]]))).toBe(false);
    expect(accepts(validator, { ok: new Set([1]) })).toBe(false);
  });
});
