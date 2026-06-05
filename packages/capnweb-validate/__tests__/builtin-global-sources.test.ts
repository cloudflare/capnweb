// Built-in globals (Request/Response) come from various sources (DOM lib,
// @cloudflare/workers-types, wrangler worker-configuration.d.ts, @types/node);
// emit v.response for any of them, but not for a module-scoped type that just
// reuses the name.
import { describe, expect, it } from "vitest";
import { transformFixture } from "./helpers.js";

const GLOBALS = `export {};
declare global {
  interface Request { readonly url: string; }
  var Request: { new (): Request };
  interface Response { readonly status: number; text(): Promise<string>; }
  var Response: { new (): Response };
}
`;
const WORKER = `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
import { RpcTarget } from "capnweb";
class Api extends RpcTarget {
  getThing(): Response { return new Response(); }
}
export function handler(req: Request, env: unknown): Response {
  return newWorkersRpcResponse(req, new Api());
}
`;

function typesPackage(name: string, body: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      version: "0.0.0",
      types: "index.d.ts",
    }),
    [`node_modules/${name}/index.d.ts`]: body,
  };
}

function getThingValidator(options: {
  files?: Record<string, string>;
  rootFiles?: string[];
  types?: string[];
  worker?: string;
} = {}): string {
  const { code } = transformFixture(options.worker ?? WORKER, {
    imports: "",
    lib: ["ES2022"],
    files: options.files,
    rootFiles: options.rootFiles,
    compilerOptions: { types: options.types ?? [] },
  });
  const line = code.split("\n").find((l) => l.includes("getThing"));
  if (!line) throw new Error("getThing validator not found in output");
  return line.trim();
}

describe("built-in global Response from any source -> v.response", () => {
  it("@cloudflare/workers-types (no DOM lib)", () => {
    expect(getThingValidator({
      files: typesPackage("@cloudflare/workers-types", GLOBALS),
      types: ["@cloudflare/workers-types"],
    })).toContain("returns: __cw.v.response");
  });

  it("wrangler-generated worker-configuration.d.ts (no package)", () => {
    expect(getThingValidator({
      files: { "worker-configuration.d.ts": GLOBALS },
      rootFiles: ["worker-configuration.d.ts"],
    })).toContain("returns: __cw.v.response");
  });

  it("@types/node", () => {
    expect(getThingValidator({
      files: typesPackage("@types/node", GLOBALS),
      types: ["node"],
    })).toContain("returns: __cw.v.response");
  });
});

describe("a module-scoped type reusing a built-in name is NOT the global", () => {
  it("node-fetch Response validates structurally, not as v.response", () => {
    const line = getThingValidator({
      files: {
        "worker-configuration.d.ts": GLOBALS,
        ...typesPackage(
          "node-fetch",
          `export class Response { readonly status: number; text(): Promise<string>; }\n`
        ),
      },
      rootFiles: ["worker-configuration.d.ts"],
      worker: `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
import { RpcTarget } from "capnweb";
import { Response as NFResponse } from "node-fetch";
class Api extends RpcTarget {
  getThing(): NFResponse { return null as any; }
}
export function handler(req: Request, env: unknown): Response {
  return newWorkersRpcResponse(req, new Api());
}
`,
    });
    expect(line).toContain("__cw.v.object");
    expect(line).not.toContain("v.response");
  });
});
