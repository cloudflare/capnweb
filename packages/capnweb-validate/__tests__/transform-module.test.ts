// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Smoke tests for the per-module transform: one representative case per
// mechanism. Depth lives in the focused test files (branded-primitive,
// record-index, mapped-types, getters, namespace-imports, unsupported-type-hook,
// method-overloads, generic-class, fetcher-detection, ...).

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RpcValidationError } from "../src/index.js";
import { createTransformContext } from "../src/transform/context.js";
import { transformModule } from "../src/transform/transform-module.js";
import { isTypeScriptLibFileName } from "../src/transform/type-introspector.js";

let dir: string;

function write(rel: string, source: string): string {
  let p = join(dir, rel);
  writeFileSync(p, source);
  return p;
}

function setup(): void {
  dir = mkdtempSync(join(tmpdir(), "capnweb-validate-tm-"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "es2022",
      module: "esnext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      types: [],
    },
    include: ["**/*.ts"],
  }));
  write("capnweb.d.ts", CAPNWEB_SHIM);
}

function teardown(): void {
  rmSync(dir, { recursive: true, force: true });
}

function transform(id: string): { code: string } {
  let ctx = createTransformContext({ tsconfig: join(dir, "tsconfig.json"), cwd: dir });
  try {
    let result = transformModule(ctx, id, readFileSync(id, "utf8"));
    if (!result) throw new Error("transformModule returned null");
    return result;
  } finally {
    ctx.dispose();
  }
}

function transformError(id: string): string {
  try {
    transform(id);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("transformModule did not throw");
}

type TestServiceValidator = {
  serviceName: string;
  methods: Record<string, {
    args: ((value: unknown, path: (string | number)[]) => void)[];
    returns: (value: unknown, path: (string | number)[]) => void;
  }>;
};

async function loadValidator(code: string, binding: string): Promise<TestServiceValidator> {
  let rt = await import("../src/internal/runtime.js");
  let prelude = code.match(/import \* as __rt from "capnweb-validate\/internal(?:\/(?:core|capnweb))?";\n([\s\S]*?)\n\s*import\s+/);
  expect(prelude, "validator prelude not found in:\n" + code).not.toBeNull();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("__rt", `${prelude![1]!}\nreturn ${binding};`)(rt) as TestServiceValidator;
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
  beforeEach(setup);
  afterEach(teardown);

  it("server: rewrites newWorkersRpcResponse and emits a validator", () => {
    let src = write("worker.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget { greet(name: string): string { return name; } }
      export function handler(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);
    let { code } = transform(src);
    expect(code).toContain("__rt.__newWorkersRpcResponseWithValidation(req, new Api()");
    expect(code).toContain(`import * as __rt from "capnweb-validate/internal/capnweb"`);
    expect(code).toMatch(/greet[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
  });

  it("client: rewrites newHttpBatchRpcSession from the explicit type argument", () => {
    let src = write("client.ts", `
      import { newHttpBatchRpcSession } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface Api extends RpcTarget { echo(value: string): Promise<string>; }
      export const api = newHttpBatchRpcSession<Api>("/rpc");
    `);
    let { code } = transform(src);
    expect(code).toMatch(/__rt\.__newHttpBatchRpcSessionWithValidation<Api>\("\/rpc"/);
    expect(code).toMatch(/echo[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
  });

  it("decorator: rewrites @validateRpc to wrap the class", () => {
    let src = write("svc.ts", `
      import { validateRpc } from "capnweb-validate";
      import { RpcTarget } from "capnweb";
      @validateRpc()
      class Api extends RpcTarget { greet(name: string): string { return name; } }
      export default Api;
    `);
    let { code } = transform(src);
    expect(code).toContain("__rt.__validateRpcClass(");
    expect(code).toMatch(/greet[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
  });

  it("decorator: filters inherited WorkerEntrypoint platform methods", () => {
    let src = write("we.ts", `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { validateRpc } from "capnweb-validate";
      @validateRpc()
      class Api extends WorkerEntrypoint { rpc(x: string): Promise<string> { return null as any; } }
      export default Api;
    `);
    let { code } = transform(src);
    expect(code).toContain('"rpc"');
    expect(code).not.toContain('"tailStream"');
    expect(code).not.toContain('"fetch"');
  });

  it("rejects a non-wire built-in at build time", () => {
    let src = write("bad.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget { fn(m: Map<string, number>): void {} }
      export function handler(req: Request): Response { return newWorkersRpcResponse(req, new Api()); }
    `);
    expect(transformError(src)).toContain("not a capnweb wire type");
  });

  it("fails loud when a marker call has no resolvable service type", () => {
    let src = write("nogeneric.ts", `
      import { newHttpBatchRpcSession } from "capnweb-validate/capnweb";
      export const api = newHttpBatchRpcSession("/rpc");
    `);
    expect(transformError(src)).toContain("could not resolve a concrete service type");
  });

  it("runtime: the emitted validator accepts good args and rejects bad ones", async () => {
    let src = write("rt.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget {
        save(user: { id: string; age: number }): void {}
      }
      export function handler(req: Request): Response { return newWorkersRpcResponse(req, new Api()); }
    `);
    let { code } = transform(src);
    let validator = await loadValidator(code, "__capnweb_validate_Api_server");
    let save = validator.methods.save!;
    expect(() => save.args[0]!({ id: "u1", age: 30 }, ["save", 0])).not.toThrow();
    expect(() => save.args[0]!({ id: "u1", age: "x" }, ["save", 0])).toThrow(RpcValidationError);
    expect(() => save.args[0]!({ id: "u1" }, ["save", 0])).toThrow(RpcValidationError);
  });
});

describe("type-introspector platform paths", () => {
  it("recognizes TypeScript lib files across separators", () => {
    expect(isTypeScriptLibFileName("/repo/node_modules/typescript/lib/lib.es2023.d.ts")).toBe(true);
    expect(isTypeScriptLibFileName("C:\\repo\\node_modules\\typescript\\lib\\lib.dom.d.ts")).toBe(true);
    expect(isTypeScriptLibFileName("/repo/src/app.ts")).toBe(false);
  });
});
