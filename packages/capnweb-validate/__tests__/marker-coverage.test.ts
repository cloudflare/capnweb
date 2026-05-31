// Contract test: every RPC entry point capnweb exports must be a known marker
// or an explicit allowlist entry, so a constructor capnweb adds later fails the
// build here instead of going silently unvalidated at its call sites.
import { describe, it, expect } from "vitest";
import * as capnweb from "capnweb";
import { MARKERS } from "../src/transform/transform-module.js";

// capnweb entry points intentionally not wrapped, each with its reason. The
// default import cannot see runtime-conditional exports (e.g. the `bun`
// condition), which is also why Bun's session lives here rather than as a marker.
const INTENTIONALLY_UNSUPPORTED: Record<string, string> = {
  newBunWebSocketRpcSession: "Bun {stub,transport} return shape needs a dedicated helper",
};

// A session or response constructor: the two call forms that create a boundary.
function isRpcEntryPoint(name: string): boolean {
  return /Rpc(Session|Response)$/.test(name);
}

describe("marker coverage stays in sync with capnweb", () => {
  it("every capnweb RPC entry point is a marker or explicitly unsupported", () => {
    let entryPoints = Object.keys(capnweb).filter(isRpcEntryPoint);
    expect(entryPoints.length).toBeGreaterThan(0); // guard: capnweb shape changed
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
});
