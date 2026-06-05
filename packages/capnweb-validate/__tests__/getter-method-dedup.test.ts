// A getter and a same-named, same-shape method must not dedup to one validator:
// the dedup signature includes isGetter, so a `get config(): string` service and
// a `config(): string` service get distinct validators with the correct flag.
import { describe, it, expect } from "vitest";
import { checkedMethod, loadValidator, transformFixture } from "./helpers.js";
import { v } from "../src/internal/core.js";

describe("getter vs method dedup", () => {
  it("emits a getter validator (isGetter) distinct from a same-shape method", () => {
    // One class exposes `get config(): string`, another `config(): string`.
    // Both are server targets via separate handlers so both validators emit.
    const { code } = transformFixture(
      `class WithGetter extends RpcTarget {
  get config(): string {
    return "x";
  }
}
class WithMethod extends RpcTarget {
  config(): string {
    return "y";
  }
}`,
      {
        imports: `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
import { RpcTarget } from "capnweb";
`,
        // two handlers so both surfaces are reachable
        target: "new WithGetter()",
      },
    );
    // The getter service's config carries isGetter: true.
    const config = checkedMethod(
      loadValidator(code, "__capnweb_validate_WithGetter_server"),
      "config"
    );
    expect(config.returns).toBe(v.string);
    expect(config.isGetter).toBe(true);
  });

  it("does not reuse a getter validator for a plain method of the same shape", () => {
    // Single module, both shapes present via two server handlers. If dedup
    // collapsed them, only one config validator (with one isGetter value) would
    // exist and one of the two would be wrong. Assert both forms are present.
    const { code } = transformFixture(
      `class WithGetter extends RpcTarget {
  get config(): string {
    return "x";
  }
}
class WithMethod extends RpcTarget {
  config(): string {
    return "y";
  }
}
export function h2(req: Request): Promise<Response> {
  return newWorkersRpcResponse(req, new WithMethod());
}`,
      {
        imports: `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
import { RpcTarget } from "capnweb";
`,
        target: "new WithGetter()",
      },
    );
    // A getter form and a non-getter form of `config` both appear.
    const getterConfig = checkedMethod(
      loadValidator(code, "__capnweb_validate_WithGetter_server"),
      "config"
    );
    expect(getterConfig.returns).toBe(v.string);
    expect(getterConfig.isGetter).toBe(true);

    const methodConfig = checkedMethod(
      loadValidator(code, "__capnweb_validate_WithMethod_server"),
      "config"
    );
    expect(methodConfig.returns).toBe(v.string);
    expect(methodConfig.isGetter).not.toBe(true);
  });
});
