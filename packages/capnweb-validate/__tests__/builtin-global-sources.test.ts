// Built-in globals (Request/Response) come from various sources (DOM lib, @cloudflare/workers-types, wrangler worker-configuration.d.ts, @types/node); emit v.response for any of them, but not for a module-scoped type that just reuses the name.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTransformContext } from "../src/transform/context.js";
import { transformModule } from "../src/transform/transform-module.js";
import { SHIM } from "./helpers.js";

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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "capnweb-validate-globals-"));
  writeFileSync(join(dir, "capnweb.d.ts"), SHIM);
  writeFileSync(join(dir, "worker.ts"), WORKER);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTsconfig(extra: object): void {
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        ...extra,
      },
      include: ["**/*.ts", "**/*.d.ts"],
    }),
  );
}

function writeTypesPackage(name: string, body: string): void {
  const pkg = join(dir, "node_modules", name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name, version: "0.0.0", types: "index.d.ts" }),
  );
  writeFileSync(join(pkg, "index.d.ts"), body);
}

function getThingValidator(): string {
  const ctx = createTransformContext({ tsconfig: join(dir, "tsconfig.json"), cwd: dir });
  try {
    const workerPath = join(dir, "worker.ts");
    const result = transformModule(ctx, workerPath, readFileSync(workerPath, "utf8"));
    if (!result) throw new Error("transformModule returned null");
    const line = result.code.split("\n").find((l) => l.includes("getThing"));
    if (!line) throw new Error("getThing validator not found in output");
    return line.trim();
  } finally {
    ctx.dispose();
  }
}

describe("built-in global Response from any source -> v.response", () => {
  it("@cloudflare/workers-types (no DOM lib)", () => {
    writeTypesPackage("@cloudflare/workers-types", GLOBALS);
    writeTsconfig({ lib: ["ES2022"], types: ["@cloudflare/workers-types"] });
    expect(getThingValidator()).toContain("returns: __rt.v.response");
  });

  it("wrangler-generated worker-configuration.d.ts (no package)", () => {
    writeFileSync(join(dir, "worker-configuration.d.ts"), GLOBALS);
    writeTsconfig({ lib: ["ES2022"] });
    expect(getThingValidator()).toContain("returns: __rt.v.response");
  });

  it("@types/node", () => {
    writeTypesPackage("@types/node", GLOBALS);
    writeTsconfig({ lib: ["ES2022"], types: ["node"] });
    expect(getThingValidator()).toContain("returns: __rt.v.response");
  });
});

describe("a module-scoped type reusing a built-in name is NOT the global", () => {
  it("node-fetch Response validates structurally, not as v.response", () => {
    writeFileSync(join(dir, "worker-configuration.d.ts"), GLOBALS); // globals for handler/shim
    writeTypesPackage(
      "node-fetch",
      `declare module "node-fetch" {
  export class Response { readonly status: number; text(): Promise<string>; }
}
`,
    );
    writeFileSync(
      join(dir, "worker.ts"),
      `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";
import { RpcTarget } from "capnweb";
import { Response as NFResponse } from "node-fetch";
class Api extends RpcTarget {
  getThing(): NFResponse { return null as any; }
}
export function handler(req: Request, env: unknown): Response {
  return newWorkersRpcResponse(req, new Api());
}
`,
    );
    writeTsconfig({ lib: ["ES2022"] });
    const line = getThingValidator();
    expect(line).toContain("__rt.v.object");
    expect(line).not.toContain("v.response");
  });
});
