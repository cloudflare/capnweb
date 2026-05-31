// A getter and a same-named, same-shape method must not dedup to one validator:
// the dedup signature includes isGetter, so a `get config(): string` service and
// a `config(): string` service get distinct validators with the correct flag.
import { describe, it, expect } from "vitest";
import { transformFixture, prelude } from "./helpers.js";

describe("getter vs method dedup", () => {
  it("emits a getter validator (isGetter) distinct from a same-shape method", () => {
    // One class exposes `get config(): string`, another `config(): string`.
    // Both are server targets via separate handlers so both validators emit.
    const { code } = transformFixture(
      `class WithGetter extends RpcTarget { get config(): string { return "x"; } }
       class WithMethod extends RpcTarget { config(): string { return "y"; } }`,
      {
        imports:
          `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";\n` +
          `import { RpcTarget } from "capnweb";\n`,
        // two handlers so both surfaces are reachable
        target: "new WithGetter()",
      },
    );
    const validators = prelude(code, "class WithGetter");
    // The getter service's config carries isGetter: true.
    expect(validators).toMatch(/"config":\s*\{[^}]*isGetter:\s*true/);
  });

  it("does not reuse a getter validator for a plain method of the same shape", () => {
    // Single module, both shapes present via two server handlers. If dedup
    // collapsed them, only one config validator (with one isGetter value) would
    // exist and one of the two would be wrong. Assert both forms are present.
    const { code } = transformFixture(
      `class WithGetter extends RpcTarget { get config(): string { return "x"; } }
       class WithMethod extends RpcTarget { config(): string { return "y"; } }
       export function h2(req: Request): Promise<Response> {
         return newWorkersRpcResponse(req, new WithMethod());
       }`,
      {
        imports:
          `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";\n` +
          `import { RpcTarget } from "capnweb";\n`,
        target: "new WithGetter()",
      },
    );
    const validators = prelude(code, "class WithGetter");
    // A getter form and a non-getter form of `config` both appear.
    expect(validators).toMatch(/"config":\s*\{[^}]*isGetter:\s*true/);
    expect(validators).toMatch(/"config":\s*\{\s*args:\s*\[\],\s*returns:\s*__rt\.v\.string\s*\}/);
  });
});
