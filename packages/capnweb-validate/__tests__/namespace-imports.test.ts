// Regression: collectors only matched bare-identifier callees, so namespace-qualified
// markers (ns.marker(...)) were silently skipped instead of rewritten.
import { describe, expect, it } from "vitest";
import {
  checkedMethod,
  loadValidator,
  transformFixture,
} from "./helpers.js";
import { v } from "../src/internal/core.js";

// Shim adds a capnweb-module copy of newWorkersRpcResponse so namespace calls resolve.
const CAPNWEB_SHIM = `
declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
  export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>;
}
declare module "capnweb-validate/capnweb" {
  export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>;
}
`;

describe("namespace-import marker calls are transformed, not silently skipped", () => {
  it("server: import * as cv (validate pkg) -> cv.newWorkersRpcResponse()", () => {
    const { code } = transformFixture(
      `class Api extends RpcTarget {
  greet(name: string): string {
    return "hi " + name;
  }
}
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
    expect(code).toContain("__cw.__newWorkersRpcResponseWithValidation");
    const greet = checkedMethod(loadValidator(code), "greet");
    expect(greet.args[0]).toBe(v.string);
    expect(greet.returns).toBe(v.string);
  });

  it("decorator: import * as cv -> @cv.validateRpc() is transformed", () => {
    const { code } = transformFixture(
      `@cv.validateRpc()
class Api extends RpcTarget {
  greet(name: string): string {
    return name;
  }
}
export function handler(req: Request): Promise<Response> {
  return cv2.newWorkersRpcResponse(req, new Api());
}
`,
      {
        shim: `${CAPNWEB_SHIM}
declare module "capnweb-validate" {
  export function validateRpc<T = unknown>(): any;
}`,
        imports: `import * as cv from "capnweb-validate";
import * as cv2 from "capnweb-validate/capnweb";
import { RpcTarget } from "capnweb";
`,
      },
    );
    expect(code).toContain("__cw.__validateRpcClass");
    const greet = checkedMethod(loadValidator(code), "greet");
    expect(greet.args[0]).toBe(v.string);
    expect(greet.returns).toBe(v.string);
  });

});
