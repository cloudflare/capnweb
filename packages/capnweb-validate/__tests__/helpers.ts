// Shared fixtures for transform tests: build a throwaway project in a tmpdir,
// run the real transform, and return the generated code plus any warnings.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransformContext } from "../src/transform/context.js";
import { transformModule } from "../src/transform/transform-module.js";

/** Base capnweb shim: RpcTarget plus the server marker. */
export const SHIM = `declare module "capnweb" {
  export class RpcTarget { readonly __RPC_TARGET_BRAND: never; }
}
declare module "capnweb-validate/capnweb" {
  export function newWorkersRpcResponse(request: Request, target: object): Promise<Response>;
}`;

/** SHIM plus the decorator markers, for @validateRpc / @skipRpcValidation tests. */
export const DECORATOR_SHIM = `${SHIM}
declare module "capnweb-validate" {
  export function validateRpc<T = unknown>(): any;
  export function skipRpcValidation(...a: unknown[]): unknown;
}`;

export type FixtureOptions = {
  /** Ambient .d.ts contents. Defaults to SHIM. */
  shim?: string;
  /** tsconfig `lib` list. Defaults to ["es2022", "DOM"]. */
  lib?: string[];
  /** Import lines prepended to the body. Defaults to the server marker + RpcTarget. */
  imports?: string;
  /** When set, append a handler returning newWorkersRpcResponse(req, <target>). */
  target?: string;
  /** Forwarded to the transform context: decide unsupported-type handling. */
  onUnsupportedType?: (info: { typeName: string }) => "passthrough" | "reject" | undefined;
};

export type FixtureResult = { code: string; warns: string[] };

const DEFAULT_IMPORTS =
  `import { newWorkersRpcResponse } from "capnweb-validate/capnweb";\n` +
  `import { RpcTarget } from "capnweb";\n`;

/**
 * Transform `body` in a throwaway project, capturing console.warn. Returns the
 * generated `code` and `warns`. Throws if the transform reports a build error.
 */
export function transformFixture(
  body: string,
  opts: FixtureOptions = {}
): FixtureResult {
  const dir = mkdtempSync(join(tmpdir(), "capnweb-validate-"));
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (m: unknown) => {
    warns.push(String(m));
  };
  try {
    writeFileSync(join(dir, "capnweb.d.ts"), opts.shim ?? SHIM);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          lib: opts.lib ?? ["es2022", "DOM"],
          types: [],
        },
        include: ["**/*.ts"],
      })
    );
    const imports = opts.imports ?? DEFAULT_IMPORTS;
    const tail = opts.target
      ? `\nexport function handler(req: Request): Promise<Response> { return newWorkersRpcResponse(req, ${opts.target}); }`
      : "";
    const wp = join(dir, "worker.ts");
    writeFileSync(wp, imports + body + tail);
    const ctx = createTransformContext({
      tsconfig: join(dir, "tsconfig.json"),
      cwd: dir,
      onUnsupportedType: opts.onUnsupportedType,
    });
    try {
      const r = transformModule(ctx, wp, readFileSync(wp, "utf8"));
      if (!r) throw new Error("transformModule returned null");
      return { code: r.code, warns };
    } finally {
      ctx.dispose();
    }
  } finally {
    console.warn = origWarn;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The build error message, or throws if the transform unexpectedly succeeds. */
export function transformError(body: string, opts: FixtureOptions = {}): string {
  try {
    transformFixture(body, opts);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a build error but transform succeeded");
}

/** Generated validator prelude: everything before `marker` in the code. */
export function prelude(code: string, marker = "class Api"): string {
  const i = code.indexOf(marker);
  return i > 0 ? code.slice(0, i) : code;
}
