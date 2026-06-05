// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Smoke tests for the per-module transform: one representative case per
// mechanism. Depth lives in the focused test files (branded-primitive,
// record-index, mapped-types, getters, namespace-imports, rpc-compatible-types,
// method-overloads, generic-class, fetcher-detection, ...).

import { describe, expect, it } from "vitest";

import { isTypeScriptLibFileName } from "../src/transform/type-introspector.js";
import { checkedMethod, loadValidator, transformFixture } from "./helpers.js";
import { v } from "../src/internal/core.js";

function transform(source: string): { code: string } {
  return transformFixture(source, { shim: CAPNWEB_SHIM, imports: "" });
}

function transformError(source: string): string {
  try {
    transform(source);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("transformModule did not throw");
}

// Minimal capnweb type stand-ins so the fixture's TypeChecker resolves the
// markers without installing real capnweb types.
const CAPNWEB_SHIM = `
declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
  type StubBase<T> = { readonly __RPC_STUB_BRAND: T };
  type Provider<T> = { readonly [K in keyof T]: T[K] };
  export type RpcStub<T> = T extends object ? Provider<T> & StubBase<T> : StubBase<T>;
  export function newHttpBatchRpcSession<T>(url: string | Request, options?: unknown): RpcStub<T>;
}
declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    readonly __WORKER_ENTRYPOINT_BRAND: never;
    fetch?(request: Request): Response | Promise<Response>;
    tailStream?(event: unknown): unknown;
  }
  export class DurableObject<Env = unknown> {
    readonly __DURABLE_OBJECT_BRAND: never;
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
  }
}
declare module "capnweb-validate" {
  export function validateRpc(...args: unknown[]): unknown;
}
declare module "capnweb-validate/capnweb" {
  import type { RpcStub } from "capnweb";
  export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>;
  export function newHttpBatchRpcSession<T>(url: string | Request, options?: unknown): RpcStub<T>;
}
`;

describe("transformModule", () => {
  it("server: rewrites newWorkersRpcResponse and emits a validator", () => {
    let { code } = transform(`
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget { greet(name: string): string { return name; } }
      export function handler(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);
    expect(code).toContain("__cw.__newWorkersRpcResponseWithValidation(req, new Api()");
    expect(code).toContain(`import * as __cw from "capnweb-validate/internal/capnweb"`);
    const greet = checkedMethod(loadValidator(code), "greet");
    expect(greet.args[0]).toBe(v.string);
    expect(greet.returns).toBe(v.string);
  });

  it("client: rewrites newHttpBatchRpcSession from the explicit type argument", () => {
    let { code } = transform(`
      import { newHttpBatchRpcSession } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface Api extends RpcTarget { echo(value: string): Promise<string>; }
      export const api = newHttpBatchRpcSession<Api>("/rpc");
    `);
    expect(code).toContain(`__cw.__newHttpBatchRpcSessionWithValidation<Api>("/rpc"`);
    const echo = checkedMethod(
      loadValidator(code, "__capnweb_validate_Api_client"),
      "echo"
    );
    expect(echo.args[0]).toBe(v.string);
    expect(echo.returns).toBe(v.string);
  });

  it("decorator: rewrites @validateRpc to wrap the class", () => {
    let { code } = transform(`
      import { validateRpc } from "capnweb-validate";
      import { RpcTarget } from "capnweb";
      @validateRpc()
      class Api extends RpcTarget { greet(name: string): string { return name; } }
      export default Api;
    `);
    expect(code).toContain("__cw.__validateRpcClass(");
    const greet = checkedMethod(loadValidator(code), "greet");
    expect(greet.args[0]).toBe(v.string);
    expect(greet.returns).toBe(v.string);
  });

  it("decorator: filters inherited WorkerEntrypoint platform methods", () => {
    let { code } = transform(`
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { validateRpc } from "capnweb-validate";
      @validateRpc()
      class Api extends WorkerEntrypoint { rpc(x: string): Promise<string> { return null as any; } }
      export default Api;
    `);
    const validator = loadValidator(code);
    expect(Object.keys(validator.methods)).toEqual(["rpc"]);
    expect(checkedMethod(validator, "rpc").args[0]).toBe(v.string);
    // fetch/tailStream are platform hooks: pass-through, not validated methods.
    expect(validator.passthrough).toEqual(
      expect.arrayContaining(["fetch", "tailStream"])
    );
  });

  it("decorator: filters inherited DurableObject platform methods", () => {
    let { code } = transform(`
      import { DurableObject } from "cloudflare:workers";
      import { validateRpc } from "capnweb-validate";
      @validateRpc()
      class Api extends DurableObject { rpc(x: string): Promise<string> { return null as any; } }
      export default Api;
    `);
    const validator = loadValidator(code);
    expect(Object.keys(validator.methods)).toEqual(["rpc"]);
    // fetch/alarm are platform hooks: pass-through, not validated methods.
    expect(validator.passthrough).toEqual(expect.arrayContaining(["fetch", "alarm"]));
  });

  it("rejects a non-cloneable built-in at build time", () => {
    expect(transformError(`
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget { fn(m: WeakMap<object, number>): void {} }
      export function handler(req: Request): Response { return newWorkersRpcResponse(req, new Api()); }
    `)).toContain("not a supported RPC validation type");
  });

  it("fails loud when a marker call has no resolvable service type", () => {
    expect(transformError(`
      import { newHttpBatchRpcSession } from "capnweb-validate/capnweb";
      export const api = newHttpBatchRpcSession("/rpc");
    `)).toContain("could not resolve a concrete service type");
  });

  it("runtime: the emitted validator accepts good args and rejects bad ones", async () => {
    let { code } = transform(`
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget {
        save(user: { id: string; age: number }): void {}
      }
      export function handler(req: Request): Response { return newWorkersRpcResponse(req, new Api()); }
    `);
    let validator = loadValidator(code);
    let save = validator.methods.save!;
    expect(() => save.args[0]!({ id: "u1", age: 30 }, ["save", 0])).not.toThrow();
    expect(() => save.args[0]!({ id: "u1", age: "x" }, ["save", 0])).toThrow(TypeError);
    expect(() => save.args[0]!({ id: "u1" }, ["save", 0])).toThrow(TypeError);
  });
});

describe("type-introspector platform paths", () => {
  it("recognizes TypeScript lib files across separators", () => {
    expect(isTypeScriptLibFileName("/repo/node_modules/typescript/lib/lib.es2023.d.ts")).toBe(true);
    expect(isTypeScriptLibFileName("C:\\repo\\node_modules\\typescript\\lib\\lib.dom.d.ts")).toBe(true);
    expect(isTypeScriptLibFileName("/repo/src/app.ts")).toBe(false);
  });
});
