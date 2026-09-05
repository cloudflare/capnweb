// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// The wrapper form: `validateRpc(Api)` and
// `validateRpc<Surface>()(Api)` must emit the same validator and the same
// applied decorator as `@validateRpc()`.
import { describe, expect, it } from "vitest";
import {
  checkedMethod,
  loadValidator,
  SHIM,
  transformError,
  transformFixture,
} from "./helpers.js";
import type { ServiceValidator } from "../src/internal/core.js";

// Mirrors the real overloads: direct call returns the class, the factory
// returns the decorator.
const WRAPPER_SHIM = `${SHIM}
declare module "capnweb-validate" {
  export function validateRpc(options: { skip: readonly string[] }): void;
  export function validateRpc<S>(options: { skip: readonly (keyof S & string)[] }): void;
  export function validateRpc<T>(value: T, context?: unknown): T;
  export function validateRpc<T>(value: T, options: { skip: readonly string[] }): T;
  export function validateRpc<S = unknown>(): <T>(value: T, context?: unknown) => T;
  export function skipRpcValidation(...a: unknown[]): unknown;
}`;

const IMPORTS = `import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { RpcTarget } from "capnweb";
`;

function compile(body: string): { code: string; warns: string[] } {
  return transformFixture(body, { shim: WRAPPER_SHIM, imports: IMPORTS });
}

function compileError(body: string): string {
  return transformError(body, { shim: WRAPPER_SHIM, imports: IMPORTS });
}

const API = `class Api extends RpcTarget {
  async authenticate(token: string): Promise<number> {
    return token.length;
  }
}
`;

describe("validateRpc wrapper form", () => {
  it("rewrites `validateRpc(Api)` to the applied decorator, keeping the class argument", () => {
    const { code } = compile(`${API}export default validateRpc(Api);`);

    expect(code).toContain(
      "export default __cw.__validateRpcClass(__capnweb_validate_Api_server)(Api);"
    );
    const validator: ServiceValidator = loadValidator(code);
    expect(validator.serviceName).toBe("Api");
    expect(Object.keys(validator.methods)).toEqual(["authenticate"]);
    expect(checkedMethod(validator, "authenticate").args).toHaveLength(1);
  });

  it("takes the RPC surface from the factory type argument", () => {
    const { code } = compile(
      `interface Surface {
  authenticate(token: string): Promise<number>;
}
class Api extends RpcTarget implements Surface {
  async authenticate(token: string): Promise<number> {
    return token.length;
  }
  async internal(): Promise<void> {}
}
export default validateRpc<Surface>()(Api);`
    );

    expect(code).toContain("__cw.__validateRpcClass(");
    expect(code).toContain(")(Api);");
    // `internal` is outside the declared surface, so it is not validated.
    expect(Object.keys(loadValidator(code).methods)).toEqual(["authenticate"]);
  });

  it("honors @skipRpcValidation on the wrapped class", () => {
    const { code } = compile(
      `class Api extends RpcTarget {
  async authenticate(token: string): Promise<number> {
    return token.length;
  }
  @skipRpcValidation()
  async raw(blob: unknown): Promise<void> {}
}
export default validateRpc(Api);`
    );

    const validator = loadValidator(code);
    expect(validator.methods.raw).toEqual({ unchecked: true });
  });

  it("skips methods named by the skip option", () => {
    const { code } = compile(
      `class Api extends RpcTarget {
  async authenticate(token: string): Promise<number> {
    return token.length;
  }
  async raw(blob: unknown): Promise<void> {}
}
export default validateRpc(Api, { skip: ["raw"] });`
    );

    const validator = loadValidator(code);
    expect(validator.methods.raw).toEqual({ unchecked: true });
    expect(checkedMethod(validator, "authenticate").args).toHaveLength(1);
    // The option is an argument, not the callee, so it survives the rewrite.
    expect(code).toContain(`)(Api, { skip: ["raw"] });`);
  });

  it("rejects a skipped name that is not in the surface", () => {
    expect(
      compileError(`${API}export default validateRpc(Api, { skip: ["nope"] });`)
    ).toContain("Api.nope");
  });

  it("rejects a skipped name that is listed twice", () => {
    expect(
      compileError(
        `${API}export default validateRpc(Api, { skip: ["raw", "raw"] });`
      )
    ).toContain("`raw` is listed twice");
  });

  it("accepts an empty skip list", () => {
    const { code } = compile(
      `${API}export default validateRpc(Api, { skip: [] });`
    );

    const validator = loadValidator(code);
    expect(checkedMethod(validator, "authenticate").args).toHaveLength(1);
  });

  it("rejects an options object with no skip list", () => {
    expect(
      compileError(`${API}export default validateRpc(Api, {});`)
    ).toContain("must be written inline");
  });

  it("rejects skip names the transform cannot read at build time", () => {
    expect(
      compileError(
        `${API}const opts = { skip: ["authenticate"] };
export default validateRpc(Api, opts);`
      )
    ).toContain("must be written inline");
  });

  it("finds the class when the name is merged with an interface", () => {
    const { code } = compile(
      `interface Api {}
${API}export default validateRpc(Api);`
    );

    const validator = loadValidator(code);
    expect(Object.keys(validator.methods)).toEqual(["authenticate"]);
  });

  it("dedups identical shapes across wrapper sites", () => {
    const { code } = compile(
      `${API}export const A = validateRpc(Api);
export const B = validateRpc(Api);`
    );

    expect(code.match(/const __capnweb_validate_\w+ =/g)).toHaveLength(1);
    expect(
      code.match(
        /__cw\.__validateRpcClass\(__capnweb_validate_Api_server\)\(Api\)/g
      )
    ).toHaveLength(2);
  });

  it("does not double-rewrite a decorator that also parses as a call", () => {
    const { code } = compile(`@validateRpc()
class Api extends RpcTarget {
  async authenticate(token: string): Promise<number> {
    return token.length;
  }
}
export default Api;`);

    expect(code.match(/__validateRpcClass/g)).toHaveLength(1);
  });

  it("rewrites namespace-qualified wrapper calls", () => {
    const { code } = transformFixture(
      `${API}export const A = cv.validateRpc(Api);
export const B = cv.validateRpc<Api>()(Api);`,
      {
        shim: WRAPPER_SHIM,
        imports: `import * as cv from "capnweb-validate";
import { RpcTarget } from "capnweb";
`,
      }
    );

    expect(code.match(/__cw\.__validateRpcClass\(/g)).toHaveLength(2);
    expect(code).not.toContain("cv.validateRpc");
    expect(
      checkedMethod(loadValidator(code), "authenticate").args
    ).toHaveLength(1);
  });

  it("rejects a type argument on the direct call, pointing at the factory form", () => {
    const message = compileError(
      `interface Surface {
  authenticate(token: string): Promise<number>;
}
${API}export default validateRpc<Surface>(Api as any);`
    );

    expect(message).toContain("validateRpc<Surface>()(MyClass)");
  });

  it("rejects an argument that is not a class declared in this module", () => {
    const message = compileError(
      `${API}const Alias = Api;
export default validateRpc(Alias);`
    );

    expect(message).toContain("name of a class declared in this module");
  });

  it("rewrites a static block call, leaving the class exported under its own name", () => {
    const { code } = compile(
      `export class Api extends RpcTarget {
  static { validateRpc(); }

  async authenticate(token: string): Promise<number> {
    return token.length;
  }
}`
    );

    expect(code).toContain(
      "static { __cw.__validateRpcClass(__capnweb_validate_Api_server)(Api); }"
    );
    const validator: ServiceValidator = loadValidator(code);
    expect(validator.serviceName).toBe("Api");
    expect(checkedMethod(validator, "authenticate").args).toHaveLength(1);
  });

  it("rejects a call placed before the class declaration", () => {
    const message = compileError(`export const A = validateRpc(Api);\n${API}`);

    expect(message).toContain("must appear after the declaration of `Api`");
  });

  it("rejects a discarded call outside the class body", () => {
    const message = compileError(`${API}validateRpc(Api);`);

    expect(message).toContain("static { validateRpc(); }");
  });

  it("rewrites a static block call that skips a method", () => {
    const { code } = compile(
      `export class Api extends RpcTarget {
  static { validateRpc({ skip: ["raw"] }); }

  async authenticate(token: string): Promise<number> {
    return token.length;
  }

  async raw(body: unknown): Promise<void> {}
}`
    );

    const validator: ServiceValidator = loadValidator(code);
    expect(validator.methods.raw).toEqual({ unchecked: true });
    expect(checkedMethod(validator, "authenticate").args).toHaveLength(1);
  });

  it("takes the surface from a static block type argument", () => {
    const { code } = compile(
      `interface Surface {
  authenticate(token: string): Promise<number>;
}
export class Api extends RpcTarget {
  static { validateRpc<Surface>(); }

  async authenticate(token: string): Promise<number> {
    return token.length;
  }

  async internal(): Promise<void> {}
}`
    );

    const validator: ServiceValidator = loadValidator(code);
    expect(validator.methods.internal).toBeUndefined();
    expect(checkedMethod(validator, "authenticate").args).toHaveLength(1);
  });

  it("takes both the surface and the skip list from a static block", () => {
    const { code } = compile(
      `interface Surface {
  authenticate(token: string): Promise<number>;
  raw(body: unknown): Promise<void>;
}
export class Api extends RpcTarget {
  static { validateRpc<Surface>({ skip: ["raw"] }); }

  async authenticate(token: string): Promise<number> {
    return token.length;
  }

  async raw(body: unknown): Promise<void> {}

  async internal(): Promise<void> {}
}`
    );

    const validator: ServiceValidator = loadValidator(code);
    expect(validator.methods.internal).toBeUndefined();
    expect(validator.methods.raw).toEqual({ unchecked: true });
    expect(checkedMethod(validator, "authenticate").args).toHaveLength(1);
  });

  it("rejects a call with no class outside a static block", () => {
    const message = compileError(`${API}validateRpc();`);

    expect(message).toContain("static block in a named class declaration");
  });

  it("rejects a call with no class in a class expression's static block", () => {
    const message = compileError(
      `export const Api = class extends RpcTarget {
  static { validateRpc(); }
};`
    );

    expect(message).toContain("static block in a named class declaration");
  });

  it("rejects a static block in some other class", () => {
    const message = compileError(
      `${API}export class Other extends RpcTarget {
  static { validateRpc(Api); }
}`
    );

    expect(message).toContain("static block in the body of `Api`");
  });

  it("rewrites a static block call that shares the block with other code", () => {
    const { code } = compile(
      `export class Api extends RpcTarget {
  static ready = false;

  static {
    validateRpc();
    Api.ready = true;
  }

  async authenticate(token: string): Promise<number> {
    return token.length;
  }
}`
    );

    expect(code).toContain(
      "__cw.__validateRpcClass(__capnweb_validate_Api_server)(Api);"
    );
    expect(
      checkedMethod(loadValidator(code), "authenticate").args
    ).toHaveLength(1);
  });

  it("rejects an inline class expression", () => {
    const message = compileError(
      `export default validateRpc(class Api extends RpcTarget {
  async authenticate(token: string): Promise<number> {
    return token.length;
  }
});`
    );

    expect(message).toContain("name of a class declared in this module");
  });
});
