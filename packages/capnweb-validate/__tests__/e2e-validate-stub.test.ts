// End-to-end: transform validateStub source → load the emitted validator →
// wire it through wrapClientStub → assert runtime validation behavior.
import { describe, it, expect } from "vitest";
import {
  transformFixture,
  loadValidator,
  checkedMethod,
  type FixtureOptions,
} from "./helpers.js";
import { v, wrapClientStub } from "../src/internal/core.js";

const CAPNWEB_SHIM = `
declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
  type StubBase<T> = { readonly __RPC_STUB_BRAND: T };
  type Provider<T> = { readonly [K in keyof T]: T[K] };
  export type RpcStub<T> = T extends object ? Provider<T> & StubBase<T> : StubBase<T>;
  export function newHttpBatchRpcSession<T>(url: string | Request, options?: unknown): RpcStub<T>;
}
declare module "capnweb-validate" {
  export function validateStub<T>(stub: object): unknown;
}`;

function transform(source: string, opts?: FixtureOptions) {
  return transformFixture(source, { shim: CAPNWEB_SHIM, imports: "", ...opts });
}

function fakeStub(
  methods: Record<string, (...a: unknown[]) => unknown>
): Record<string, unknown> {
  const s: Record<string, unknown> = { ...methods };
  s.dup = () => fakeStub(methods);
  return s;
}

describe("e2e: transform → load validator → wrapClientStub runtime", () => {
  const SOURCE = `
    import { validateStub } from "capnweb-validate";
    import { newHttpBatchRpcSession, RpcTarget } from "capnweb";
    interface Api extends RpcTarget {
      echo(value: string): Promise<string>;
      add(a: number, b: number): Promise<number>;
    }
    export const api = validateStub<Api>(newHttpBatchRpcSession<Api>("/rpc"));
  `;

  it("emits a client validator with correct method specs", () => {
    const { code } = transform(SOURCE);
    const validator = loadValidator(code, "__capnweb_validate_Api_client");

    const echo = checkedMethod(validator, "echo");
    expect(echo.args).toBeUndefined();
    expect(echo.returns).toBe(v.string);

    const add = checkedMethod(validator, "add");
    expect(add.args).toBeUndefined();
    expect(add.returns).toBe(v.number);
  });

  it("wrapClientStub validates return values at runtime", () => {
    const { code } = transform(SOURCE);
    const validator = loadValidator(code, "__capnweb_validate_Api_client");

    const good = wrapClientStub(
      fakeStub({ echo: () => "ok", add: () => 42 }),
      validator
    ) as { echo(x: string): unknown; add(a: number, b: number): unknown };

    expect(good.echo("hi")).toBe("ok");
    expect(good.add(1, 2)).toBe(42);

    const bad = wrapClientStub(
      fakeStub({ echo: () => 123, add: () => "nope" }),
      validator
    ) as { echo(x: string): unknown; add(a: number, b: number): unknown };

    expect(() => bad.echo("hi")).toThrow(TypeError);
    expect(() => bad.add(1, 2)).toThrow(TypeError);
  });

  it("client does not validate outgoing arguments (server does)", () => {
    const { code } = transform(SOURCE);
    const validator = loadValidator(code, "__capnweb_validate_Api_client");

    const stub = wrapClientStub(
      fakeStub({ echo: () => "ok" }),
      validator
    ) as { echo(x: unknown): unknown };

    expect(() => stub.echo(999)).not.toThrow();
  });

  it("refuses calls to methods outside the validated surface", () => {
    const { code } = transform(SOURCE);
    const validator = loadValidator(code, "__capnweb_validate_Api_client");

    const stub = wrapClientStub(
      fakeStub({ echo: () => "ok", secret: () => "leak" }),
      validator
    ) as Record<string, (...a: unknown[]) => unknown>;

    expect(() => stub.secret()).toThrow(TypeError);
  });

  it("async return values are validated on resolve", async () => {
    const { code } = transform(SOURCE);
    const validator = loadValidator(code, "__capnweb_validate_Api_client");

    const stub = wrapClientStub(
      fakeStub({ echo: () => Promise.resolve(42) }),
      validator
    ) as { echo(x: string): Promise<unknown> };

    await expect(stub.echo("hi")).rejects.toBeInstanceOf(TypeError);
  });

  it("dup() returns a still-validated stub", () => {
    const { code } = transform(SOURCE);
    const validator = loadValidator(code, "__capnweb_validate_Api_client");

    const stub = wrapClientStub(
      fakeStub({ echo: () => 999 }),
      validator
    ) as { dup(): { echo(x: string): unknown } };

    expect(() => stub.dup().echo("hi")).toThrow(TypeError);
  });
});
