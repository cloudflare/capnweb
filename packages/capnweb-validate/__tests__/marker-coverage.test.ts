// Contract test: every RPC entry point capnweb exports, across all of its
// runtime export conditions (default, workerd, bun), must be a known marker or
// an explicit allowlist entry. A constructor capnweb adds later fails here
// instead of going silently unvalidated at its call sites.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { MARKERS } from "../src/transform/transform-module.js";

// capnweb resolves to a different bundle per export condition. Reading exports
// at runtime would require executing each bundle, but the workers bundle imports
// `cloudflare:workers`, which is unavailable under node. Instead, read the names
// statically from each condition's .d.ts `export { ... }` declaration, which
// lists every export without executing platform-coupled code.
const require = createRequire(import.meta.url);
const distDir = dirname(require.resolve("capnweb"));
const CONDITION_DTS = ["index.d.ts", "index-workers.d.ts", "index-bun.d.ts"];

function allCapnwebExports(): Set<string> {
  let names = new Set<string>();
  for (const file of CONDITION_DTS) {
    let src = readFileSync(join(distDir, file), "utf8");
    for (let block of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (let entry of block[1]!.split(",")) {
        // Strip `type ` and `X as Y` aliases; keep the exported name.
        let name = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

// A constructor that creates an RPC boundary: a session, a response, or a
// handler (e.g. newBunWebSocketRpcHandler). Anything matching must be wrapped.
function isRpcEntryPoint(name: string): boolean {
  return /Rpc(Session|Response|Handler)$/.test(name);
}

// capnweb entry points intentionally not wrapped, each with its reason.
const INTENTIONALLY_UNSUPPORTED: Record<string, string> = {
  newBunWebSocketRpcSession: "Bun {stub,transport} return shape needs a dedicated helper",
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
