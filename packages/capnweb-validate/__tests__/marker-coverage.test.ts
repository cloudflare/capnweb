// Contract test: every RPC entry point capnweb exports, across all of its
// runtime export conditions (default, workerd, bun), must be a known marker or
// an explicit allowlist entry. A constructor capnweb adds later fails here
// instead of going silently unvalidated at its call sites.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { MARKERS } from "../src/transform/transform-module.js";

// Read source entry points instead of importing capnweb: workers/bun entry
// points are platform-coupled, and capnweb is an optional peer of this package.
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const ENTRYPOINTS = ["src/index.ts", "src/index-workers.ts", "src/index-bun.ts"];

function allCapnwebExports(): Set<string> {
  let names = new Set<string>();
  let seen = new Set<string>();
  for (const file of ENTRYPOINTS) readExports(file);
  return names;

  function readExports(file: string): void {
    if (seen.has(file)) return;
    seen.add(file);
    let src = readFileSync(join(repoRoot, file), "utf8");
    for (let star of src.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
      let specifier = star[1]!;
      if (!specifier.startsWith(".")) continue;
      let resolved = join(dirname(file), specifier).replace(/\.js$/, ".ts");
      readExports(resolved);
    }
    for (let block of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (let entry of block[1]!.split(",")) {
        // Strip `type ` and `X as Y` aliases; keep the exported name.
        let name = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
        if (name) names.add(name);
      }
    }
    for (let decl of src.matchAll(/export\s+(?:async\s+)?(?:const|let|class|function|interface)\s+(\w+)/g)) {
      names.add(decl[1]!);
    }
  }
}

// A constructor that exposes a server RPC boundary: a response or a handler
// (e.g. newBunWebSocketRpcHandler). Anything matching must be wrapped.
function isRpcEntryPoint(name: string): boolean {
  return /Rpc(Response|Handler)$/.test(name);
}

// capnweb entry points intentionally not wrapped, each with its reason.
const INTENTIONALLY_UNSUPPORTED: Record<string, string> = {
  newBunWebSocketRpcHandler: "Bun server handler (callback-supplied target) needs a dedicated helper",
};

describe("marker coverage stays in sync with capnweb", () => {
  let exports = allCapnwebExports();
  let entryPoints = [...exports].filter(isRpcEntryPoint);

  it("sees capnweb's full multi-condition export surface", () => {
    // Guard against the resolution silently breaking (wrong path, renamed
    // bundle): we must observe the known boundary constructors.
    expect(entryPoints.length).toBeGreaterThan(0);
    expect(exports.has("newBunWebSocketRpcSession")).toBe(true); // bun-only export is visible
  });

  it("every capnweb RPC entry point is a marker or explicitly unsupported", () => {
    let uncovered = entryPoints.filter(
      (name) => !(name in MARKERS) && !(name in INTENTIONALLY_UNSUPPORTED),
    );
    expect(
      uncovered,
      `capnweb exports these RPC entry points with no marker and no ` +
        `INTENTIONALLY_UNSUPPORTED entry. Add a marker (and runtime helper), ` +
        `or document why it is unsupported: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("the unsupported allowlist does not list names we actually cover", () => {
    let stale = Object.keys(INTENTIONALLY_UNSUPPORTED).filter((n) => n in MARKERS);
    expect(stale, `remove from INTENTIONALLY_UNSUPPORTED: ${stale.join(", ")}`).toEqual([]);
  });

  it("every allowlisted name still exists in capnweb (no stale allowlist)", () => {
    let gone = Object.keys(INTENTIONALLY_UNSUPPORTED).filter((n) => !exports.has(n));
    expect(gone, `no longer exported by capnweb, drop from allowlist: ${gone.join(", ")}`).toEqual([]);
  });
});
