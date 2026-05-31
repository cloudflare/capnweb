// Regression: collectors only matched bare-identifier callees, so namespace-qualified
// markers (ns.marker(...)) were silently skipped instead of rewritten.
import { describe, expect, it } from "vitest";
import { transformFixture, transformError } from "./helpers.js";

// Shim adds the client marker (newHttpBatchRpcSession + RpcStub shape) and a
// capnweb-module copy of newWorkersRpcResponse so namespace calls resolve.
const CAPNWEB_SHIM = `
declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
  type StubBase<T> = { readonly __RPC_STUB_BRAND: T };
  type Provider<T> = { readonly [K in keyof T]: T[K] };
  export type RpcStub<T> = T extends object ? Provider<T> & StubBase<T> : StubBase<T>;
  export function newHttpBatchRpcSession<T>(url: string | Request, options?: unknown): RpcStub<T>;
  export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>;
}
declare module "capnweb-validate/capnweb" {
  export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>;
}
`;

describe("namespace-import marker calls are transformed, not silently skipped", () => {
  it("client: import * as capnweb -> capnweb.newHttpBatchRpcSession<Api>()", () => {
    const { code } = transformFixture(
      `interface Api extends RpcTarget { echo(value: string): Promise<string>; }
export const api = capnweb.newHttpBatchRpcSession<Api>("/rpc");
`,
      {
        shim: CAPNWEB_SHIM,
        imports: `import * as capnweb from "capnweb";
import { RpcTarget } from "capnweb";
`,
      },
    );
    expect(code).toContain("__rt.__newHttpBatchRpcSessionWithValidation");
    expect(code).toContain("import * as __rt from");
    expect(code).toMatch(/echo[\s\S]*?args:\s*\[__rt\.v\.string\]/);
  });

  it("server: import * as cv (validate pkg) -> cv.newWorkersRpcResponse()", () => {
    const { code } = transformFixture(
      `class Api extends RpcTarget { greet(name: string): string { return "hi " + name; } }
export function handler(req: Request): Promise<Response> {
  return cv.newWorkersRpcResponse(req, new Api());
}
`,
      {
        shim: CAPNWEB_SHIM,
        imports: `import * as cv from "capnweb-validate/capnweb";
import { RpcTarget } from "capnweb";
`,
      },
    );
    expect(code).toContain("__rt.__newWorkersRpcResponseWithValidation");
    expect(code).toMatch(/greet[\s\S]*?args:\s*\[__rt\.v\.string\]/);
  });

  it("client: a renamed import (newHttpBatchRpcSession as connect) is matched by resolved name", () => {
    const { code } = transformFixture(
      `interface Api extends RpcTarget { echo(value: string): Promise<string>; }
export const api = connect<Api>("/rpc");
`,
      {
        shim: CAPNWEB_SHIM,
        imports: `import { newHttpBatchRpcSession as connect } from "capnweb";
import { RpcTarget } from "capnweb";
`,
      },
    );
    expect(code).toContain("__rt.__newHttpBatchRpcSessionWithValidation");
    expect(code).toMatch(/echo[\s\S]*?args:\s*\[__rt\.v\.string\]/);
  });

  it("fails loud: a namespace marker call with no resolvable type throws", () => {
    const msg = transformError(
      `export const api = capnweb.newHttpBatchRpcSession("/rpc");
`,
      {
        shim: CAPNWEB_SHIM,
        imports: `import * as capnweb from "capnweb";
`,
      },
    );
    expect(msg).toContain("could not resolve a concrete service type");
  });
});
