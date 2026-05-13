// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { emitViteRegistration, generateValidatorsOnly, type GenResult } from "./generate.js";
import { transformClientCalls } from "./rewrite.js";

type CapnwebState = {
  inputAbs: string;
  outDirAbs: string;
  validatorsAbs: string;
  clientsAbs: string;
  knownClasses: Set<string>;
  registrations: GenResult["registrations"];
};

export type CapnwebVitePluginOptions = {
  /** Worker / RPC entry file to inspect. Defaults to `src/worker.ts`. */
  input?: string;
  /** Directory where generated validators are written. Defaults to `.capnweb`. */
  outDir?: string;
};

type ViteConfig = { root?: string };
type ViteServer = { watcher?: { on(event: string, callback: (path: string) => void): void } };
type ViteTransformResult = string | { code: string; map?: unknown } | null;

type VitePlugin = {
  name: string;
  enforce: "pre";
  configResolved(config: ViteConfig): void;
  buildStart(): void;
  configureServer(server: ViteServer): void;
  transform(code: string, id: string): ViteTransformResult;
};

export default function capnweb(options: CapnwebVitePluginOptions = {}): VitePlugin {
  let root = process.cwd();
  let state: CapnwebState = {
    inputAbs: "",
    outDirAbs: "",
    validatorsAbs: "",
    clientsAbs: "",
    knownClasses: new Set(),
    registrations: [],
  };
  let generated = false;

  let run = () => {
    state.inputAbs = resolve(root, options.input ?? "src/worker.ts");
    state.outDirAbs = resolve(root, options.outDir ?? ".capnweb");
    state.validatorsAbs = resolve(state.outDirAbs, "validators.ts");
    state.clientsAbs = resolve(state.outDirAbs, "clients.ts");
    let result: GenResult = generateValidatorsOnly({ input: state.inputAbs, outDir: state.outDirAbs });
    state.knownClasses = new Set(result.classes);
    state.registrations = result.registrations;
    generated = true;
  };

  return {
    name: "capnweb:typecheck",
    enforce: "pre",
    configResolved(config) { root = config.root ?? root; },
    buildStart() { run(); },
    configureServer(server) {
      if (!generated) run();
      // Re-runs full codegen on any TS file change. This is simple but
      // re-creates the TypeScript program each time; acceptable for typical
      // project sizes but could be optimized with incremental compilation
      // or reachable-file filtering for very large codebases.
      server.watcher?.on("change", path => {
        if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return;
        if (path === state.validatorsAbs || path === state.clientsAbs) return;
        if (state.outDirAbs && (path === state.outDirAbs || path.startsWith(state.outDirAbs + sep))) return;
        generated = false;
        run();
      });
    },
    transform(code, id) {
      if (!id || id.startsWith("\0")) return null;
      let cleanId = id.split(/[?#]/, 1)[0];
      if (cleanId.includes("node_modules")) return null;
      if (cleanId.includes(`${sep}.capnweb${sep}`) || cleanId.includes("/.capnweb/")) return null;
      if (!/\.(?:ts|tsx|mts|cts)$/.test(cleanId)) return null;
      if (cleanId.endsWith(".d.ts") || cleanId.endsWith(".d.cts") || cleanId.endsWith(".d.mts")) return null;
      if (state.knownClasses.size === 0) return null;
      if (!existsSync(state.clientsAbs)) throw new Error("capnweb/vite has not generated clients.ts yet.");

      let clientsImport = jsImportPath(relative(dirname(cleanId), state.clientsAbs));
      let rewritten = transformClientCalls(code, state.knownClasses, clientsImport, cleanId);
      if (cleanId === state.inputAbs) {
        let registration = emitViteRegistration(state.registrations, state.inputAbs, state.validatorsAbs);
        rewritten = registration.imports + `\n` + rewritten + `\n` + registration.call + `\n`;
      }
      return rewritten === code ? null : { code: rewritten };
    },
  };
}

function jsImportPath(path: string): string {
  let normalized = path.split(sep).join("/");
  let ext = normalized.match(/\.(ts|tsx|mts|cts)$/);
  if (ext) normalized = normalized.slice(0, -ext[0].length) + ".js";
  if (!normalized.startsWith("./") && !normalized.startsWith("../")) normalized = "./" + normalized;
  return normalized;
}
