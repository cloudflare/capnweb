// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// End-to-end test for the per-module transform. Each case writes a tiny
// fixture to a tempdir, builds a real `TransformContext` over it, runs
// `transformModule()`, then asserts on the rewritten code. One case also
// evaluates the emitted validator against the live runtime to prove the
// validator the transform builds actually catches bad inputs.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RpcValidationError } from "../src/index.js";
import { createTransformContext } from "../src/transform/context.js";
import { transformModule } from "../src/transform/transform-module.js";
import { isTypeScriptLibFileName } from "../src/transform/type-introspector.js";

let dir: string;

beforeEach(() => {
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, source: string): string {
  let p = join(dir, rel);
  writeFileSync(p, source);
  return p;
}

function transform(id: string): { code: string; map?: string } {
  let ctx = createTransformContext({
    tsconfig: join(dir, "tsconfig.json"),
    cwd: dir,
  });
  try {
    let result = transformModule(ctx, id, require("node:fs").readFileSync(id, "utf8"));
    if (!result) throw new Error("transformModule returned null");
    return result;
  } finally {
    ctx.dispose();
  }
}

type TestServiceValidator = {
  serviceName: string;
  methods: Record<string, {
    args: ((value: unknown, path: (string | number)[]) => void)[];
    rest?: (value: unknown, path: (string | number)[]) => void;
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

// Minimal stand-ins for capnweb types. We declare them locally in each
// fixture so the transform's TypeChecker can resolve them without the test
// needing to install the real `capnweb` types into the fixture's program.
// `RpcStub<T>` expands to an intersection, like the real capnweb types,
// so client factories must prefer explicit service type arguments.
const CAPNWEB_SHIM = `
declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
  export interface RpcTransport {}
  type StubBase<T> = { readonly __RPC_STUB_BRAND: T };
  type Provider<T> = { readonly [K in keyof T]: T[K] };
  export type RpcStub<T> = T extends object ? Provider<T> & StubBase<T> : StubBase<T>;
  export function newHttpBatchRpcSession<T>(
      url: string | Request, options?: unknown): RpcStub<T>;
  export function newWebSocketRpcSession<T>(
      webSocket: WebSocket | string, localMain?: unknown, options?: unknown): RpcStub<T>;
  export function newMessagePortRpcSession<T>(
      port: MessagePort, localMain?: unknown, options?: unknown): RpcStub<T>;
  export class RpcSession<T = unknown> {
    constructor(transport: RpcTransport, localMain?: unknown, options?: unknown);
    getRemoteMain(): RpcStub<T>;
  }
}
declare module "cloudflare:workers" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
  export class WorkerEntrypoint<Env = unknown> {
    readonly __WORKER_ENTRYPOINT_BRAND: never;
    fetch?(request: Request): Response | Promise<Response>;
    queue?(batch: unknown): void | Promise<void>;
    scheduled?(controller: unknown): void | Promise<void>;
    tail?(events: unknown[]): void | Promise<void>;
    tailStream?(event: unknown): unknown;
    trace?(traces: unknown[]): void | Promise<void>;
    test?(controller: unknown): void | Promise<void>;
  }
  type StubBase<T> = { readonly __RPC_STUB_BRAND: T };
  type Provider<T> = { readonly [K in keyof T]: T[K] };
  export type RpcStub<T> = T extends object ? Provider<T> & StubBase<T> : StubBase<T>;
}
type Fetcher<T = undefined, Reserved extends string = never> =
  (T extends object
    ? Pick<T, Exclude<keyof T, Reserved | "fetch" | "connect">>
    : unknown) & {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      connect(address: string): unknown;
    };
declare module "capnweb-validate" {
  export function validateRpc(...args: unknown[]): unknown;
  export function skipRpcValidation(...args: unknown[]): unknown;
}
declare module "capnweb-validate/capnweb" {
  import type { RpcStub, RpcTransport } from "capnweb";
  export { RpcStub, RpcTransport };
  export function validateRpc(...args: unknown[]): unknown;
  export function skipRpcValidation(...args: unknown[]): unknown;
  export function newWorkersRpcResponse(
      request: Request, target: object): Promise<Response>;
  export function newWorkersWebSocketRpcResponse(
      request: Request, target: object, options?: unknown): Response;
  export function newHttpBatchRpcResponse(
      request: Request, target: object, options?: unknown): Promise<Response>;
  export function nodeHttpBatchRpcResponse(
      request: { method?: string; url?: string; headers?: unknown },
      response: object, target: object, options?: unknown): Promise<void>;
  export function newHttpBatchRpcSession<T>(
      url: string | Request, options?: unknown): RpcStub<T>;
  export function newWebSocketRpcSession<T>(
      webSocket: WebSocket | string, localMain?: unknown, options?: unknown): RpcStub<T>;
  export function newMessagePortRpcSession<T>(
      port: MessagePort, localMain?: unknown, options?: unknown): RpcStub<T>;
  export class RpcSession<T = unknown> {
    constructor(transport: RpcTransport, localMain?: unknown, options?: unknown);
    getRemoteMain(): RpcStub<T>;
  }
}
`;

describe("transformModule: server boundary rewrite", () => {
  it("rewrites newWorkersRpcResponse and emits a validator for the target type", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("worker.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget {
        greet(name: string): string { return "hi " + name; }
      }
      export function handler(req: Request, env: unknown): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);

    // Marker call site rewritten to the runtime helper.
    expect(code).toContain("__rt.__newWorkersRpcResponseWithValidation(req, new Api()");
    // Runtime import injected.
    expect(code).toContain(`import * as __rt from "capnweb-validate/internal/capnweb"`);
    // Server-side validator emitted for the Api shape.
    expect(code).toContain("const __capnweb_validate_Api_server");
    // Greet method's args validator includes the string primitive.
    expect(code).toMatch(/greet[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
  });
});

describe("transformModule: client session rewrite", () => {
  it("rewrites newHttpBatchRpcSession using the explicit type argument", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("client.ts", `
      import { newHttpBatchRpcSession } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface Api extends RpcTarget {
        echo(value: string): Promise<string>;
      }
      export const api = newHttpBatchRpcSession<Api>("/rpc");
    `);

    let { code } = transform(src);

    // The type argument `<Api>` between the rewritten callee and the open
    // paren is preserved verbatim; we only swap the identifier itself.
    expect(code).toMatch(/__rt\.__newHttpBatchRpcSessionWithValidation<Api>\("\/rpc"/);
    expect(code).toContain("const __capnweb_validate_Api_client");
    expect(code).toMatch(/echo[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
    expect(code).toMatch(/echo[^}]*returns:\s*__rt\.v\.string/s);
  });

  it("rewrites Cap'n Web client imports without marker APIs", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("client-capnweb.ts", `
      import { newHttpBatchRpcSession, RpcTarget } from "capnweb";
      interface Api extends RpcTarget {
        echo(value: string): Promise<string>;
      }
      export const api = newHttpBatchRpcSession<Api>("/rpc");
    `);

    let { code } = transform(src);

    expect(code).toMatch(/__rt\.__newHttpBatchRpcSessionWithValidation<Api>\("\/rpc"/);
    expect(code).toContain("const __capnweb_validate_Api_client");
    expect(code).toMatch(/echo[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
  });

  it("rewrites `new RpcSession<T>(transport)` into a call helper", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("session.ts", `
      import { RpcSession, RpcTransport } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface Api extends RpcTarget {
        ping(value: number): Promise<number>;
      }
      export function open(t: RpcTransport) {
        return new RpcSession<Api>(t);
      }
    `);

    let { code } = transform(src);

    // The whole \`new RpcSession<Api>(...)\` head turns into a call to the
    // runtime helper. \`new\` is gone, the type argument and the transport
    // argument are preserved.
    expect(code).toMatch(/__rt\.__newRpcSessionWithValidation<Api>\(t,\s*__capnweb_validate_Api_client\)/);
    expect(code).not.toMatch(/new\s+RpcSession/);
    expect(code).toContain("const __capnweb_validate_Api_client");
  });

  it("throws when `new RpcSession` has no resolvable type argument", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("bad-session.ts", `
      import { RpcSession, RpcTransport } from "capnweb-validate/capnweb";
      export function open(t: RpcTransport) {
        return new RpcSession(t);
      }
    `);
    expect(() => transform(src)).toThrow(/could not resolve a concrete service type/);
  });
});

describe("transformModule: decorator rewrite", () => {
  it("rewrites @validateRpc() and uses the capnweb-free runtime", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("decorator.ts", `
      import { validateRpc } from "capnweb-validate";
      import { RpcTarget } from "capnweb";
      @validateRpc()
      class Api extends RpcTarget {
        greet(name: string): string { return "hi " + name; }
      }
      export { Api };
    `);

    let { code } = transform(src);

    expect(code).toContain(`import * as __rt from "capnweb-validate/internal/core"`);
    expect(code).toContain("@__rt.__validateRpcClass(__capnweb_validate_Api_server)");
    expect(code).toContain("const __capnweb_validate_Api_server");
    expect(code).toMatch(/greet[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
  });

  it("supports the bare @validateRpc spelling", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("bare-decorator.ts", `
      import { validateRpc } from "capnweb-validate";
      import { RpcTarget } from "capnweb";
      @validateRpc
      class Api extends RpcTarget {
        ping(): string { return "pong"; }
      }
    `);

    let { code } = transform(src);

    expect(code).toContain("@__rt.__validateRpcClass(__capnweb_validate_Api_server)");
    expect(code).toMatch(/ping[^}]*returns:\s*__rt\.v\.string/s);
  });

  it("uses an explicit decorator type argument as the RPC surface", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("decorator-interface.ts", `
      import { validateRpc } from "capnweb-validate";
      import { RpcTarget } from "capnweb";
      interface PublicApi {
        greet(name: string): string;
      }
      @validateRpc<PublicApi>()
      class Api extends RpcTarget {
        greet(name: string): string { return "hi " + name; }
        helper(value: number): number { return value; }
      }
    `);

    let { code } = transform(src);

    expect(code).toContain("const __capnweb_validate_PublicApi_server");
    expect(code).toMatch(/greet[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
    expect(code).not.toMatch(/helper[^}]*args:/s);
  });

  it("warns when an explicit decorator type argument contains any", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("decorator-any.ts", `
      import { validateRpc } from "capnweb-validate";
      import { RpcTarget } from "capnweb";
      interface Cursor<T> {
        next(): Promise<T | null>;
      }
      @validateRpc<Cursor<any>>()
      class ArrayCursor<T> extends RpcTarget implements Cursor<T> {
        async next(): Promise<T | null> { return null; }
      }
    `);
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      let { code } = transform(src);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(
        "@validateRpc type argument contains `any`"
      );
      expect(code).toContain("const __capnweb_validate_Cursor_server");
      expect(code).toMatch(/next[^}]*returns:\s*__rt\.v\.any/s);
    } finally {
      warn.mockRestore();
    }
  });

  it("uses a single implemented interface and applies method opt-outs", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("decorator-implements.ts", `
      import { validateRpc, skipRpcValidation } from "capnweb-validate";
      import { RpcTarget } from "capnweb";
      interface PublicApi {
        greet(name: string): string;
        unsafe(value: Map<string, number>): number;
      }
      @validateRpc()
      class Api extends RpcTarget implements PublicApi {
        greet(name: string): string { return "hi " + name; }
        @skipRpcValidation()
        unsafe(value: Map<string, number>): number { return value.size; }
        helper(value: number): number { return value; }
      }
    `);

    let { code } = transform(src);

    expect(code).toContain('"unsafe": { unchecked: true }');
    expect(code).toMatch(/greet[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
    expect(code).not.toMatch(/helper[^}]*args:/s);
  });

  it("emits worker entrypoint metadata for lifecycle pass-through", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("worker-entrypoint.ts", `
      import { validateRpc } from "capnweb-validate";
      import { WorkerEntrypoint } from "cloudflare:workers";
      interface Env {}
      interface PublicApi {
        describe(): string;
      }
      @validateRpc()
      export class Api extends WorkerEntrypoint<Env> implements PublicApi {
        describe(): string { return "ok"; }
      }
    `);

    let { code } = transform(src);

    expect(code).toContain('targetKind: "workerEntrypoint"');
    expect(code).toMatch(/describe[^}]*returns:\s*__rt\.v\.string/s);
  });
});

// One fixture per kind keeps assertions focused; the file-per-test pattern
// matches the rest of this suite.
describe("transformModule: wire-supported kinds", () => {
  function buildServer(name: string, fields: string): string {
    return `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class ${name} extends RpcTarget {
        ${fields}
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new ${name}());
      }
    `;
  }

  // (label, method signature, expected `v.<kind>` token the emitter must use)
  let cases: [string, string, RegExp][] = [
    ["Date",            "fn(d: Date): Date",                                /v\.date/],
    ["Uint8Array",      "fn(b: Uint8Array): Uint8Array",                    /v\.bytes/],
    ["Error",           "fn(e: Error): Error",                              /v\.error/],
    ["Blob",            "fn(b: Blob): Blob",                                /v\.blob/],
    ["ReadableStream",  "fn(s: ReadableStream): ReadableStream",            /v\.readableStream/],
    ["WritableStream",  "fn(s: WritableStream): WritableStream",            /v\.writableStream/],
    ["Headers",         "fn(h: Headers): Headers",                          /v\.headers/],
    ["Request",         "fn(r: Request): Request",                          /v\.request/],
    ["Response",        "fn(r: Response): Response",                        /v\.response/],
    // Plain functions and stub-like values are pass-by-reference; the emitter
    // uses `v.func` / `v.stub` rather than walking the inner shape.
    ["function",        "fn(cb: (x: number) => string): void",              /v\.func/],
  ];

  for (let [label, sig, want] of cases) {
    it(`accepts ${label}`, () => {
      write("capnweb.d.ts", CAPNWEB_SHIM);
      let src = write(`${label}.ts`, buildServer("Api", `${sig} { return undefined as any; }`));
      let { code } = transform(src);
      expect(code, `expected ${label} to map to ${want}`).toMatch(want);
    });
  }

  it("accepts RpcTarget subclasses as `stub`", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("stub.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Inner extends RpcTarget {
        ping(): string { return "pong"; }
      }
      class Outer extends RpcTarget {
        getInner(): Inner { return new Inner(); }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Outer());
      }
    `);
    let { code } = transform(src);
    // The Outer service shape's `getInner` return value is pass-by-reference,
    // with Inner's methods preserved for pipelined validation.
    expect(code).toMatch(/getInner[\s\S]*returns:\s*__rt\.v\.stubOf/);
    expect(code).toMatch(/serviceName:\s*"Inner"[\s\S]*ping[\s\S]*returns:\s*__rt\.v\.string/);
  });

  it("recognizes RpcStub aliases as pass-by-reference stubs", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("stub-alias.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      import type { RpcStub as Stub } from "capnweb";
      interface Inner extends RpcTarget {
        ping(value: string): Promise<string>;
      }
      class Outer extends RpcTarget {
        getInner(): Stub<Inner> { throw new Error("not called"); }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Outer());
      }
    `);
    let { code } = transform(src);
    expect(code).toMatch(/getInner[\s\S]*returns:\s*__rt\.v\.stubOf/);
    expect(code).not.toContain("__RPC_STUB_BRAND");
    expect(code).toMatch(/ping[\s\S]*args:\s*\[__rt\.v\.string\]/);
  });

  it("recognizes RpcTarget brands as pass-by-reference capabilities", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("target-brand.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "cloudflare:workers";
      interface Authenticated extends RpcTarget {
        ping(value: string): Promise<string>;
      }
      class Api extends RpcTarget {
        authenticate(token: string): Promise<Authenticated> {
          throw new Error("not called");
        }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);

    expect(code).toMatch(/authenticate[\s\S]*returns:\s*__rt\.v\.stubOf/);
    expect(code).toMatch(/ping[\s\S]*args:\s*\[__rt\.v\.string\]/);
    expect(code).not.toContain("__RPC_TARGET_BRAND");
  });

  it("recognizes WorkerEntrypoint Fetchers as pass-by-reference stubs", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("worker-fetcher.ts", `
      import { validateRpc } from "capnweb-validate";
      import { WorkerEntrypoint } from "cloudflare:workers";
      interface User extends WorkerEntrypoint {
        describe(): Promise<string>;
      }
      interface ConnectCallback extends WorkerEntrypoint {
        complete(user: Fetcher<User>, expiresAt?: Date): Promise<void>;
      }
      interface HookInitiator<Hook extends WorkerEntrypoint> extends WorkerEntrypoint {
        startHook(): Promise<{ hook: Fetcher<Hook> }>;
      }
      interface Vendor extends WorkerEntrypoint {
        connectAccount(callback: Fetcher<ConnectCallback>): Promise<{ url: string }>;
        setHook(hook: Fetcher<HookInitiator<User>> | null): Promise<void>;
      }
      @validateRpc<Vendor>()
      class VendorImpl extends WorkerEntrypoint implements Vendor {
        async connectAccount(_callback: Fetcher<ConnectCallback>) {
          return { url: "https://example.com" };
        }
        async setHook(_hook: Fetcher<HookInitiator<User>> | null): Promise<void> {}
      }
    `);

    let { code } = transform(src);

    expect(code).toMatch(/targetKind:\s*"workerEntrypoint"/);
    expect(code).toMatch(/connectAccount[\s\S]*args:\s*\[__rt\.v\.stubOf/);
    expect(code).toMatch(/complete[\s\S]*args:\s*\[__rt\.v\.stubOf/);
    expect(code).toMatch(/setHook[\s\S]*__rt\.v\.stubOf/);
    expect(code).toMatch(/startHook[\s\S]*returns:\s*__rt\.v\.object/);
    expect(code).toMatch(/describe[\s\S]*returns:\s*__rt\.v\.string/);
    expect(code).not.toContain("__WORKER_ENTRYPOINT_BRAND");
  });

  it("widens optional properties to `T | undefined` in plain objects", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("optional.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface Profile { name: string; nickname?: string; }
      class Api extends RpcTarget {
        update(p: Profile): void {}
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);
    let { code } = transform(src);
    // \`nickname?\` should produce a union that includes undefined so callers
    // can omit it without tripping the validator.
    expect(code).toMatch(/nickname[^,}]*v\.union\(\[[^\]]*v\.undefined_/s);
  });
});


describe("transformModule: marker helper coverage", () => {
  let serverCases: Array<[string, string, string]> = [
    ["newWorkersRpcResponse", "return newWorkersRpcResponse(req, new Api());", "__newWorkersRpcResponseWithValidation"],
    ["newWorkersWebSocketRpcResponse", "return newWorkersWebSocketRpcResponse(req, new Api(), { tag: true });", "__newWorkersWebSocketRpcResponseWithValidation"],
    ["newHttpBatchRpcResponse", "return newHttpBatchRpcResponse(req, new Api(), { tag: true });", "__newHttpBatchRpcResponseWithValidation"],
    ["nodeHttpBatchRpcResponse", "return nodeHttpBatchRpcResponse(req, res, new Api(), { tag: true });", "__nodeHttpBatchRpcResponseWithValidation"],
  ];

  for (let [marker, call, helper] of serverCases) {
    it(`rewrites ${marker}`, () => {
      write("capnweb.d.ts", CAPNWEB_SHIM);
      let src = write(`${marker}.ts`, `
        import { ${marker} } from "capnweb-validate/capnweb";
        import { RpcTarget } from "capnweb";
        class Api extends RpcTarget {
          ping(value: string): string { return value; }
        }
        export function h(req: Request, res: object): unknown {
          ${call}
        }
      `);

      let { code } = transform(src);

      expect(code).toContain(`__rt.${helper}`);
      expect(code).toContain("__capnweb_validate_Api_server");
      expect(code).toMatch(/ping[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
    });
  }

  let clientCases: Array<[string, string, string]> = [
    ["newHttpBatchRpcSession", "return newHttpBatchRpcSession<Api>(\"/rpc\", { tag: true });", "__newHttpBatchRpcSessionWithValidation"],
    ["newWebSocketRpcSession", "return newWebSocketRpcSession<Api>(ws, localMain, { tag: true });", "__newWebSocketRpcSessionWithValidation"],
    ["newMessagePortRpcSession", "return newMessagePortRpcSession<Api>(port, localMain, { tag: true });", "__newMessagePortRpcSessionWithValidation"],
    ["RpcSession", "return new RpcSession<Api>(transport, localMain, { tag: true });", "__newRpcSessionWithValidation"],
  ];

  for (let [marker, call, helper] of clientCases) {
    it(`rewrites ${marker}`, () => {
      write("capnweb.d.ts", CAPNWEB_SHIM);
      let importName = marker === "RpcSession" ? "RpcSession, RpcTransport" : marker;
      let src = write(`${marker}.ts`, `
        import { ${importName} } from "capnweb-validate/capnweb";
        import { RpcTarget } from "capnweb";
        interface Api extends RpcTarget {
          ping(value: string): Promise<string>;
        }
        export function h(
            ws: WebSocket, port: MessagePort, transport: RpcTransport,
            localMain: unknown): unknown {
          ${call}
        }
      `);

      let { code } = transform(src);

      expect(code).toContain(`__rt.${helper}<Api>`);
      expect(code).toContain("__capnweb_validate_Api_client");
      expect(code).toMatch(/ping[^}]*returns:\s*__rt\.v\.string/s);
      if (marker === "RpcSession") expect(code).not.toMatch(/new\s+RpcSession/);
    });
  }
});

describe("transformModule: primitive matrix", () => {
  it("emits runtime validators for primitive and permissive leaves", async () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("primitive-matrix.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      type Literal = "ok" | 7 | true;
      class Api extends RpcTarget {
        primitive(
            bool: boolean, big: bigint, nil: null, undef: undefined,
            nothing: void, literal: Literal, anyValue: any,
            unknownValue: unknown): void {}
      }
      export function h(req: Request): Promise<Response> {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);
    expect(code).toContain("__rt.v.boolean");
    expect(code).toContain("__rt.v.bigint");
    expect(code).toContain("__rt.v.null_");
    expect(code).toContain("__rt.v.undefined_");
    expect(code).toContain("__rt.v.any");

    let validator = await loadValidator(code, "__capnweb_validate_Api_server");
    let method = validator.methods.primitive!;
    expect(() => method.args[0]!(false, ["primitive", 0])).not.toThrow();
    expect(() => method.args[0]!(0, ["primitive", 0])).toThrow(RpcValidationError);
    expect(() => method.args[1]!(1n, ["primitive", 1])).not.toThrow();
    expect(() => method.args[1]!(1, ["primitive", 1])).toThrow(RpcValidationError);
    expect(() => method.args[2]!(null, ["primitive", 2])).not.toThrow();
    expect(() => method.args[2]!(undefined, ["primitive", 2])).toThrow(RpcValidationError);
    expect(() => method.args[3]!(undefined, ["primitive", 3])).not.toThrow();
    expect(() => method.args[4]!(undefined, ["primitive", 4])).not.toThrow();
    expect(() => method.args[5]!("ok", ["primitive", 5])).not.toThrow();
    expect(() => method.args[5]!(7, ["primitive", 5])).not.toThrow();
    expect(() => method.args[5]!(true, ["primitive", 5])).not.toThrow();
    expect(() => method.args[5]!(false, ["primitive", 5])).toThrow(RpcValidationError);
    expect(() => method.args[6]!(Symbol("any"), ["primitive", 6])).not.toThrow();
    expect(() => method.args[7]!({ unknown: true }, ["primitive", 7])).not.toThrow();
    expect(() => method.returns(undefined, ["primitive", "return"])).not.toThrow();
    expect(() => method.returns("value", ["primitive", "return"])).toThrow(RpcValidationError);
  });
});

describe("transformModule: container validation", () => {
  it("validates nested arrays, objects, unions, and tuples", async () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("containers.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface Meta { active: boolean; }
      interface Profile { name: string; meta: Meta; }
      type Choice = string | number;
      class Api extends RpcTarget {
        save(matrix: string[][], profile: Profile, choice: Choice,
            pair: [string, number]): Profile { return profile; }
      }
      export function h(req: Request): Promise<Response> {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);
    expect(code).toContain("__rt.v.tuple([__rt.v.string, __rt.v.number])");
    let validator = await loadValidator(code, "__capnweb_validate_Api_server");
    let method = validator.methods.save!;

    expect(() => method.args[0]!([["a"], []], ["save", 0])).not.toThrow();
    expect(() => method.args[0]!([[1]], ["save", 0])).toThrow(RpcValidationError);
    expect(() => method.args[1]!({ name: "Ada", meta: { active: true } }, ["save", 1])).not.toThrow();
    expect(() => method.args[1]!({ name: "Ada", meta: { active: 1 } }, ["save", 1])).toThrow(RpcValidationError);
    expect(() => method.args[2]!("id", ["save", 2])).not.toThrow();
    expect(() => method.args[2]!(123, ["save", 2])).not.toThrow();
    expect(() => method.args[2]!(false, ["save", 2])).toThrow(RpcValidationError);
    expect(() => method.args[3]!(["id", 123], ["save", 3])).not.toThrow();
    expect(() => method.args[3]!(["id"], ["save", 3])).toThrow(RpcValidationError);
    expect(() => method.args[3]!(["id", "bad"], ["save", 3])).toThrow(RpcValidationError);
    expect(() => method.returns({ name: "Ada", meta: { active: true } }, ["save", "return"])).not.toThrow();
    expect(() => method.returns({ name: "Ada", meta: { active: 1 } }, ["save", "return"])).toThrow(RpcValidationError);
  });
});


describe("transformModule: rest parameters", () => {
  it("validates rest parameters as variadic RPC arguments", async () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("rest.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget {
        join(prefix: string, ...parts: string[]): string { return prefix + parts.join(""); }
      }
      export function h(req: Request): Promise<Response> {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);
    expect(code).toMatch(/join[^}]*args:\s*\[\s*__rt\.v\.string\s*\][^}]*rest:\s*__rt\.v\.string/s);
    let validator = await loadValidator(code, "__capnweb_validate_Api_server");
    let method = validator.methods.join!;

    expect(() => method.args[0]!("/", ["join", 0])).not.toThrow();
    expect(() => method.rest!("a", ["join", 1])).not.toThrow();
    expect(() => method.rest!("b", ["join", 2])).not.toThrow();
    expect(() => method.rest!(1, ["join", 1])).toThrow(RpcValidationError);
    expect(() => method.rest!(["a"], ["join", 1])).toThrow(RpcValidationError);
  });

  it("expands tuple rest parameters into positional validators", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("tuple-rest.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget {
        pair(...args: [string, number]): void {}
      }
      export function h(req: Request): Promise<Response> {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);
    expect(code).toMatch(/pair[^}]*args:\s*\[\s*__rt\.v\.string,\s*__rt\.v\.number\s*\]/s);
    expect(code).not.toMatch(/pair[^}]*rest:/s);
  });
});

describe("type-introspector platform paths", () => {
  it("recognizes TypeScript lib files with POSIX and Windows separators", () => {
    expect(isTypeScriptLibFileName("/repo/node_modules/typescript/lib/lib.es2023.d.ts")).toBe(true);
    expect(isTypeScriptLibFileName("C:\\repo\\node_modules\\typescript\\lib\\lib.dom.d.ts")).toBe(true);
    expect(isTypeScriptLibFileName("/repo/src/types.d.ts")).toBe(false);
  });
});

describe("transformModule: resolved TypeScript shapes", () => {
  it("lowers Omit, Pick, Partial, intersections, and aliases", async () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("utility-types.ts", `
      import { newHttpBatchRpcSession } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      type User = { id: string; name: string; secret: boolean };
      type PublicUser = Omit<User, "secret">;
      type NameOnly = Pick<User, "name">;
      type UserPatch = Partial<User>;
      type Payload = PublicUser & { tags: string[] };
      interface Api extends RpcTarget {
        update(payload: Payload, name: NameOnly, patch: UserPatch): PublicUser;
      }
      type ApiAlias = Api;
      export const api = newHttpBatchRpcSession<ApiAlias>("/rpc");
    `);

    let { code } = transform(src);
    let binding = code.match(/const (__capnweb_validate_[A-Za-z0-9_$]+_client) =/)?.[1];
    expect(binding, "client validator binding not found in:\n" + code).toBeTruthy();
    let validator = await loadValidator(code, binding!);
    let method = validator.methods.update!;

    expect(() => method.args[0]!({ id: "1", name: "Ada", tags: ["admin"] }, ["update", 0])).not.toThrow();
    expect(() => method.args[0]!({ id: "1", name: "Ada", tags: [1] }, ["update", 0])).toThrow(RpcValidationError);
    expect(() => method.args[1]!({ name: "Ada" }, ["update", 1])).not.toThrow();
    expect(() => method.args[1]!({}, ["update", 1])).toThrow(RpcValidationError);
    expect(() => method.args[2]!({}, ["update", 2])).not.toThrow();
    expect(() => method.args[2]!({ id: 1 }, ["update", 2])).toThrow(RpcValidationError);
    expect(() => method.returns({ id: "1", name: "Ada" }, ["update", "return"])).not.toThrow();
    expect(() => method.returns({ id: "1" }, ["update", "return"])).toThrow(RpcValidationError);
  });
});

describe("transformModule: dictionary shapes", () => {
  it("supports string dictionaries and documents numeric index signatures", async () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("dictionary.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface Bag { known: string; [key: string]: string; }
      interface NumericBag { length: number; [index: number]: string; }
      class Api extends RpcTarget {
        set(values: Record<string, number>, bag: Bag,
            numeric: NumericBag): Record<string, number> { return values; }
      }
      export function h(req: Request): Promise<Response> {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);
    expect(code).toContain('__rt.v.object({ "known": __rt.v.string }, "Bag", __rt.v.string)');
    expect(code).toContain('__rt.v.object({ "length": __rt.v.number }, "NumericBag")');
    let validator = await loadValidator(code, "__capnweb_validate_Api_server");
    let method = validator.methods.set!;

    expect(() => method.args[0]!({ a: 1 }, ["set", 0])).not.toThrow();
    expect(() => method.args[0]!({ a: "x" }, ["set", 0])).toThrow(RpcValidationError);
    expect(() => method.args[1]!({ known: "x", extra: "y" }, ["set", 1])).not.toThrow();
    expect(() => method.args[1]!({ known: "x", extra: 1 }, ["set", 1])).toThrow(RpcValidationError);
    expect(() => method.args[2]!({ length: 1, 0: 2 }, ["set", 2])).not.toThrow();
    expect(() => method.returns({ a: 1 }, ["set", "return"])).not.toThrow();
    expect(() => method.returns({ a: "x" }, ["set", "return"])).toThrow(RpcValidationError);
  });

  it("skips symbol-keyed object properties", async () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("symbol-keys.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      const tag: unique symbol = Symbol("tag");
      interface Payload {
        id: string;
        [tag]: number;
        [Symbol.iterator](): Iterator<string>;
      }
      class Api extends RpcTarget {
        save(value: Payload): void {}
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);

    expect(code).toContain('__rt.v.object({ "id": __rt.v.string }, "Payload")');
    expect(code).not.toContain("__@tag");
    expect(code).not.toContain("__@iterator");

    let validator = await loadValidator(code, "__capnweb_validate_Api_server");
    let method = validator.methods.save!;
    expect(() => method.args[0]!({ id: "p_1" }, ["save", 0])).not.toThrow();
  });
});

describe("transformModule: rejected built-ins", () => {
  // Each entry pairs a service signature with the substring the build error
  // must mention. We assert on the reason text so future renames of a
  // rejection message don't go unnoticed.
  let rejected: [string, string, RegExp][] = [
    ["Map",                "fn(m: Map<string, number>): void",      /Map is not a capnweb wire type/],
    ["Set",                "fn(s: Set<string>): void",              /Set is not a capnweb wire type/],
    ["WeakMap",            "fn(m: WeakMap<object, number>): void",  /WeakMap is not a capnweb wire type/],
    ["WeakSet",            "fn(s: WeakSet<object>): void",          /WeakSet is not a capnweb wire type/],
    ["ArrayBuffer",        "fn(b: ArrayBuffer): void",              /ArrayBuffer is not a capnweb wire type/],
    ["SharedArrayBuffer",  "fn(b: SharedArrayBuffer): void",        /SharedArrayBuffer is not a capnweb wire type/],
    ["Int8Array",          "fn(b: Int8Array): void",                /Int8Array is not a capnweb wire type/],
    ["Uint8ClampedArray",  "fn(b: Uint8ClampedArray): void",        /Uint8ClampedArray is not a capnweb wire type/],
    ["Int16Array",         "fn(b: Int16Array): void",               /Int16Array is not a capnweb wire type/],
    ["Uint16Array",        "fn(b: Uint16Array): void",              /Uint16Array is not a capnweb wire type/],
    ["Int32Array",         "fn(b: Int32Array): void",               /Int32Array is not a capnweb wire type/],
    ["Uint32Array",        "fn(b: Uint32Array): void",              /Uint32Array is not a capnweb wire type/],
    ["Float32Array",       "fn(b: Float32Array): void",             /Float32Array is not a capnweb wire type/],
    ["Float64Array",       "fn(b: Float64Array): void",             /Float64Array is not a capnweb wire type/],
    ["BigInt64Array",      "fn(b: BigInt64Array): void",            /BigInt64Array is not a capnweb wire type/],
    ["BigUint64Array",     "fn(b: BigUint64Array): void",           /BigUint64Array is not a capnweb wire type/],
    ["RegExp",             "fn(r: RegExp): void",                   /RegExp is not a capnweb wire type/],
    ["DataView",           "fn(d: DataView): void",                 /DataView is not a capnweb wire type/],
  ];

  for (let [label, sig, want] of rejected) {
    it(`rejects ${label} with a pointed error`, () => {
      write("capnweb.d.ts", CAPNWEB_SHIM);
      let src = write(`reject-${label}.ts`, `
        import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
        import { RpcTarget } from "capnweb";
        class Api extends RpcTarget {
          ${sig} {}
        }
        export function h(req: Request): Response {
          return newWorkersRpcResponse(req, new Api());
        }
      `);
      expect(() => transform(src), `${label} should be rejected`).toThrow(want);
    });
  }

  it("rejects Map return types with a pointed error", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("reject-map-return.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget {
        fn(): Map<string, number> { return new Map(); }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    expect(() => transform(src)).toThrow(/fn\.return: Map is not a capnweb wire type/);
  });

  it("allows a method to opt out with @skipRpcValidation", async () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("skip-validation.ts", `
      import { newWorkersRpcResponse, skipRpcValidation } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget {
        @skipRpcValidation
        unsafe(value: Map<string, number>): number { return value.size; }
        ping(value: string): string { return value; }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);

    expect(code).toMatch(/"unsafe":\s*\{ unchecked: true \}/);
    expect(code).toMatch(/ping[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);

    let rt = await import("../src/internal/runtime.js");
    let capnweb = await import("../../../src/index.js");
    let validator = await loadValidator(code, "__capnweb_validate_Api_server");
    let channel = new MessageChannel();

    try {
      capnweb.newMessagePortRpcSession(channel.port1, {
        unsafe(value: unknown): number { return typeof value === "number" ? value : 0; },
        ping(value: string): string { return value; },
      });
      let client = rt.__newMessagePortRpcSessionWithValidation<any>(channel.port2, validator as never);

      await expect(client.unsafe(123)).resolves.toBe(123);
      expect(() => client.ping(123)).toThrow(RpcValidationError);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
});

describe("transformModule: recursive types", () => {
  it("emits lazy validators for direct object recursion", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("recursive-node.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface Node {
        value: string;
        children: Node[];
      }
      class Api extends RpcTarget {
        getNode(): Node { return undefined as any; }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);

    expect(code).toMatch(/let __capnweb_validate_Api_server_shape_\d+;/);
    expect(code).toContain("__rt.v.lazy(() => __capnweb_validate_Api_server_shape_");
    expect(code).toMatch(/getNode[^}]*returns:\s*__capnweb_validate_Api_server_shape_\d+/s);
  });

  it("emits lazy validators for mutual recursion", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("mutual-recursive.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface User { name: string; group: Group; }
      interface Group { name: string; members: User[]; }
      class Api extends RpcTarget {
        getUser(): User { return undefined as any; }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);

    expect(code).toContain("__rt.v.lazy(() => __capnweb_validate_Api_server_shape_");
    expect(code).toMatch(/members[^}]*__rt\.v\.array\(__rt\.v\.lazy/s);
  });

  it("emits lazy validators for recursive union aliases", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("recursive-union.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      type Json = string | Json[];
      class Api extends RpcTarget {
        getJson(): Json { return undefined as any; }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);

    expect(code).toMatch(/__capnweb_validate_Api_server_shape_\d+ = __rt\.v\.union\(\[/);
    expect(code).toContain("__rt.v.array(__rt.v.lazy(() => __capnweb_validate_Api_server_shape_");
    expect(code).toMatch(/getJson[^}]*returns:\s*__capnweb_validate_Api_server_shape_\d+/s);
  });

  it("still reports unsupported leaves inside recursive types", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("recursive-unsupported.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface Node {
        children: Node[];
        index: Map<string, number>;
      }
      class Api extends RpcTarget {
        getNode(): Node { return undefined as any; }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    expect(() => transform(src)).toThrow(/Map is not a capnweb wire type/);
  });

  it("still reports unsupported union branches", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("unsupported-union.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget {
        set(value: string | Map<string, number>): void {}
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    expect(() => transform(src)).toThrow(/Map is not a capnweb wire type/);
  });

  it("reports the maximum resolution depth", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let chain = Array.from({ length: 70 }, (_, i) =>
      `interface N${i} { value: ${i === 69 ? "string" : `N${i + 1}`}; }`
    ).join("\n");
    let src = write("deep.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      ${chain}
      class Api extends RpcTarget {
        getDeep(): N0 { return undefined as any; }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    expect(() => transform(src)).toThrow(/maximum resolution depth \(64\)/);
  });
});

describe("transformModule: dedup", () => {
  it("emits a single validator when one service is referenced twice", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("twice.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget {
        ping(): string { return "pong"; }
      }
      export function a(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
      export function b(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);
    let matches = code.match(/const __capnweb_validate_Api_server/g) ?? [];
    expect(matches.length).toBe(1);
    // Both call sites point at the same binding.
    let rewrites = code.match(/__rt\.__newWorkersRpcResponseWithValidation\(/g) ?? [];
    expect(rewrites.length).toBe(2);
  });


  it("suffixes validators for same-name service collisions", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("same-name.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      namespace One {
        export class Api extends RpcTarget {
          a(value: string): string { return value; }
        }
      }
      namespace Two {
        export class Api extends RpcTarget {
          b(value: number): number { return value; }
        }
      }
      export function one(req: Request): Promise<Response> {
        return newWorkersRpcResponse(req, new One.Api());
      }
      export function two(req: Request): Promise<Response> {
        return newWorkersRpcResponse(req, new Two.Api());
      }
    `);

    let { code } = transform(src);

    expect(code).toContain("const __capnweb_validate_Api_server =");
    expect(code).toContain("const __capnweb_validate_Api_server_2 =");
    expect(code).toMatch(/new One\.Api\(\), __capnweb_validate_Api_server\)/);
    expect(code).toMatch(/new Two\.Api\(\), __capnweb_validate_Api_server_2\)/);
    expect(code).toMatch(/a[^}]*args:\s*\[\s*__rt\.v\.string\s*\]/s);
    expect(code).toMatch(/b[^}]*args:\s*\[\s*__rt\.v\.number\s*\]/s);
  });
});

describe("transformModule: failure modes", () => {
  it("throws when the server target is a bare RpcTarget", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("bad-server.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      export function h(req: Request, t: RpcTarget): Response {
        return newWorkersRpcResponse(req, t);
      }
    `);
    expect(() => transform(src)).toThrow(/could not resolve a concrete service type/);
  });

  it("throws when the client call has no resolvable service type", () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    // No type argument and no contextual type, so T stays generic.
    let src = write("bad-client.ts", `
      import { newHttpBatchRpcSession } from "capnweb-validate/capnweb";
      export const api = newHttpBatchRpcSession("/rpc");
    `);
    expect(() => transform(src)).toThrow(/could not resolve a concrete service type/);
  });
});

describe("transformModule: runtime behavior", () => {
  // Take the validator object the transform emitted and run it through the
  // real runtime helpers. This proves the emitted text is well-formed and
  // that bad inputs trip `RpcValidationError`. We sidestep loading the
  // whole rewritten module - we only need the validator expression.
  it("emitted server validator rejects mistyped args", async () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("server.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      class Api extends RpcTarget {
        greet(name: string): string { return "hi " + name; }
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);

    // Grab just the `{ serviceName: "Api", methods: { ... } }` literal that
    // follows our binding. The transform's printer always emits the binding
    // as `const __capnweb_validate_Api_server = { ... };` - parse it out.
    let m = code.match(/const __capnweb_validate_Api_server = (\{[\s\S]*?\n\});/);
    expect(m, "validator literal not found in:\n" + code).not.toBeNull();
    let literalSource = m![1]!;

    // Eval the literal against the live runtime namespace.
    let rt = await import("../src/internal/runtime.js");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    let validator = new Function("__rt", `return (${literalSource});`)(rt) as {
      serviceName: string;
      methods: Record<string, { args: ((v: unknown, p: unknown) => void)[]; returns: (v: unknown, p: unknown) => void }>;
    };

    expect(validator.serviceName).toBe("Api");
    expect(Object.keys(validator.methods)).toEqual(["greet"]);

    // Good arg passes; bad arg throws an RpcValidationError tagged with the
    // service site so users see "at Api.greet.args[0]" etc.
    expect(() => validator.methods.greet!.args[0]!("alice", ["greet", "args", 0])).not.toThrow();
    let err: unknown;
    try {
      validator.methods.greet!.args[0]!(42, ["greet", "args", 0]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RpcValidationError);
    expect((err as RpcValidationError).rpcValidation.expected).toBe("string");
    expect((err as RpcValidationError).rpcValidation.actual).toBe("number");
  });


  it("runtime bytes validator accepts only Uint8Array", async () => {
    let rt = await import("../src/internal/runtime.js");

    expect(() => rt.v.bytes(new Uint8Array(), ["bytes"])).not.toThrow();
    expect(() => rt.v.bytes(new Int8Array(), ["bytes"])).toThrow(RpcValidationError);
  });

  it("client wrapper rejects bad outgoing args before transport", async () => {
    let rt = await import("../src/internal/runtime.js");
    let capnweb = await import("../../../src/index.js");
    let channel = new MessageChannel();
    let calls = 0;
    let validator = {
      serviceName: "Api",
      methods: {
        greet: { args: [rt.v.string], returns: rt.v.string },
      },
    };

    try {
      capnweb.newMessagePortRpcSession(channel.port1, {
        greet(name: string): string {
          calls++;
          return `hi ${name}`;
        },
      });
      let client = rt.__newMessagePortRpcSessionWithValidation<{
        greet(name: string): Promise<string>;
      }>(channel.port2, validator);
      let greet = client.greet as (...args: unknown[]) => unknown;

      expect(() => client.greet(123 as never)).toThrow(RpcValidationError);
      expect(() => greet("Ada", "extra")).toThrow(RpcValidationError);
      expect(calls).toBe(0);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });



  it("server wrapper passes through WorkerEntrypoint lifecycle methods", async () => {
    let rt = await import("../src/internal/runtime.js");
    let target = {
      fetch(): string { return "ok"; },
      rpc(): string { return "bad"; },
    };
    let validator = {
      serviceName: "Api",
      targetKind: "workerEntrypoint" as const,
      methods: {},
    };
    let wrapped = rt.wrapServerTarget(target, validator);

    expect(wrapped.fetch()).toBe("ok");
    expect(() => wrapped.rpc()).toThrow(RpcValidationError);
  });

  it("client wrapper rejects methods missing from the validator", async () => {
    let rt = await import("../src/internal/runtime.js");
    let capnweb = await import("../../../src/index.js");
    let channel = new MessageChannel();
    let validator = {
      serviceName: "Api",
      methods: {},
    };

    try {
      capnweb.newMessagePortRpcSession(channel.port1, {
        greet(): string { return "hi"; },
      });
      let client = rt.__newMessagePortRpcSessionWithValidation<any>(channel.port2, validator);

      expect(() => client.greet("Ada")).toThrow(RpcValidationError);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("client wrapper validates rest arguments individually", async () => {
    let rt = await import("../src/internal/runtime.js");
    let capnweb = await import("../../../src/index.js");
    let channel = new MessageChannel();
    let calls = 0;
    let validator = {
      serviceName: "Api",
      methods: {
        join: { args: [rt.v.string], rest: rt.v.string, returns: rt.v.string },
      },
    };

    try {
      capnweb.newMessagePortRpcSession(channel.port1, {
        join(prefix: string, ...parts: string[]): string {
          calls++;
          return prefix + parts.join("");
        },
      });
      let client = rt.__newMessagePortRpcSessionWithValidation<{
        join(prefix: string, ...parts: string[]): Promise<string>;
      }>(channel.port2, validator);

      await expect(client.join("/", "a", "b")).resolves.toBe("/ab");
      expect(() => client.join("/", ["a"] as never)).toThrow(RpcValidationError);
      expect(calls).toBe(1);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("client wrapper preserves RpcPromise pipelining", async () => {
    let rt = await import("../src/internal/runtime.js");
    let capnweb = await import("../../../src/index.js");
    let channel = new MessageChannel();
    let childValidator = {
      serviceName: "Child",
      methods: {
        getName: { args: [], returns: rt.v.string },
        load: { args: [rt.v.string], returns: rt.v.string },
      },
    };
    let validator = {
      serviceName: "Api",
      methods: {
        getChild: { args: [], returns: rt.v.stubOf(childValidator) },
      },
    };
    let loads = 0;
    class Child extends capnweb.RpcTarget {
      getName(): string { return "Ada"; }
      load(id: string): string {
        loads++;
        return id;
      }
    }

    try {
      capnweb.newMessagePortRpcSession(channel.port1, {
        getChild(): Child {
          return new Child();
        },
      });
      let client = rt.__newMessagePortRpcSessionWithValidation<{
        getChild(): {
          getName(): Promise<string>;
          load(id: string): Promise<string>;
        };
      }>(channel.port2, validator);
      let child = client.getChild();

      expect(typeof child.getName).toBe("function");
      expect(() => child.load(123 as never)).toThrow(RpcValidationError);
      expect(loads).toBe(0);
      await expect(child.getName()).resolves.toBe("Ada");
      await expect(child.load("ok")).resolves.toBe("ok");
      expect(loads).toBe(1);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("client wrapper validates return values from nested stubs", async () => {
    let rt = await import("../src/internal/runtime.js");
    let childValidator = {
      serviceName: "Child",
      methods: {
        getName: { args: [], returns: rt.v.string },
        load: { args: [rt.v.string], returns: rt.v.string },
      },
    };
    let validator = {
      serviceName: "Api",
      methods: {
        getChild: { args: [], returns: rt.v.stubOf(childValidator) },
      },
    };
    let client = rt.wrapClientStub({
      async getChild() {
        return {
          async getName(): Promise<number> { return 42; },
          async load(id: string): Promise<string> { return id; },
        };
      },
    }, validator) as {
      getChild(): Promise<{
        getName(): Promise<string>;
        load(id: string): Promise<string>;
      }>;
    };

    let child = await client.getChild();

    expect(() => child.load(123 as never)).toThrow(RpcValidationError);
    await expect(child.getName()).rejects.toThrow(RpcValidationError);
    await expect(child.load("ok")).resolves.toBe("ok");
  });

  it("client wrapper allows RpcPromise values as pipelined args", async () => {
    let rt = await import("../src/internal/runtime.js");
    let capnweb = await import("../../../src/index.js");
    let channel = new MessageChannel();
    let calls: string[] = [];
    let user = rt.v.object({ id: rt.v.string, name: rt.v.string }, "User");
    let profile = rt.v.object({ id: rt.v.string, bio: rt.v.string }, "Profile");
    let validator = {
      serviceName: "Api",
      methods: {
        authenticate: { args: [rt.v.string], returns: user },
        getUserProfile: { args: [rt.v.string], returns: profile },
        getNestedProfile: {
          args: [rt.v.object({ userId: rt.v.string }, "ProfileRequest")],
          returns: profile,
        },
      },
    };

    try {
      capnweb.newMessagePortRpcSession(channel.port1, {
        authenticate(_sessionToken: string): { id: string; name: string } {
          return { id: "u_1", name: "Ada Lovelace" };
        },
        getUserProfile(userId: string): { id: string; bio: string } {
          calls.push(userId);
          return { id: userId, bio: "Mathematician & first programmer" };
        },
        getNestedProfile(request: { userId: string }): { id: string; bio: string } {
          calls.push(request.userId);
          return { id: request.userId, bio: "nested" };
        },
      });
      let client = rt.__newMessagePortRpcSessionWithValidation<any>(channel.port2, validator);
      let authenticated = client.authenticate("cookie-123");
      let direct = client.getUserProfile(authenticated.id);
      let nested = client.getNestedProfile({ userId: authenticated.id });

      await expect(direct).resolves.toEqual({
        id: "u_1",
        bio: "Mathematician & first programmer",
      });
      await expect(nested).resolves.toEqual({ id: "u_1", bio: "nested" });
      expect(calls).toEqual(["u_1", "u_1"]);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("client wrapper rejects bad resolved returns before user callbacks", async () => {
    let rt = await import("../src/internal/runtime.js");
    let capnweb = await import("../../../src/index.js");
    let channel = new MessageChannel();
    let validator = {
      serviceName: "Api",
      methods: {
        greet: { args: [rt.v.string], returns: rt.v.string },
      },
    };

    try {
      capnweb.newMessagePortRpcSession(channel.port1, {
        greet(_name: string): number {
          return 42;
        },
      });
      let client = rt.__newMessagePortRpcSessionWithValidation<{
        greet(name: string): Promise<string>;
      }>(channel.port2, validator);
      let callbackRan = false;

      await expect(client.greet("Ada").then(() => {
        callbackRan = true;
      })).rejects.toThrow(RpcValidationError);
      expect(callbackRan).toBe(false);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("emitted recursive validator follows lazy back-references", async () => {
    write("capnweb.d.ts", CAPNWEB_SHIM);
    let src = write("recursive-runtime.ts", `
      import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
      import { RpcTarget } from "capnweb";
      interface Node { value: string; children: Node[]; }
      class Api extends RpcTarget {
        save(node: Node): void {}
      }
      export function h(req: Request): Response {
        return newWorkersRpcResponse(req, new Api());
      }
    `);

    let { code } = transform(src);
    let rt = await import("../src/internal/runtime.js");
    let prelude = code.match(/import \* as __rt from "capnweb-validate\/internal(?:\/(?:core|capnweb))?";\n([\s\S]*?)\n\s*import\s+/);
    expect(prelude, "validator prelude not found in:\n" + code).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    let validator = new Function("__rt", `${prelude![1]!}\nreturn __capnweb_validate_Api_server;`)(rt) as {
      methods: Record<string, { args: ((v: unknown, p: unknown) => void)[] }>;
    };

    let good = { value: "root", children: [{ value: "leaf", children: [] }] };
    expect(() => validator.methods.save!.args[0]!(good, ["Api", "save", 0])).not.toThrow();
    expect(() => validator.methods.save!.args[0]!({
      value: "root",
      children: [{ value: 42, children: [] }],
    }, ["Api", "save", 0])).toThrow(RpcValidationError);
  });
});
