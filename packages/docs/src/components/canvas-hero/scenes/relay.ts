/**
 * Scene 1a: a capability is granted, relayed onward, and then used directly.
 *
 * Three parties in the drifting field. A grants a capability to B; B passes that
 * same capability on to C; C then calls straight back to A along a route that has
 * carried nothing until now. The token keeps its identity the whole way -- it is
 * drawn as an open diamond, the only diamond on the canvas -- so what the eye
 * follows is one thing changing hands rather than three unrelated messages.
 *
 * The last leg is the point. C never received anything from A and has no prior
 * relationship with it, yet the call it makes is direct. That is what "a stub can
 * be passed across RPC again, including over independent connections" looks like
 * when you draw it: authority travels, and it still works at the far end.
 *
 * Docs: `concepts/stubs.md` (passing stubs onward), `guides/security.md`
 * (capabilities as the unit of authority).
 */
import type { Scene, SceneSize } from "../types";
import { Field } from "./field";

type Phase = "grant" | "relay" | "use" | "reply" | "hold";

/** Seconds per phase, in order. `hold` lets the finished picture sit a moment. */
const DUR: Record<Phase, number> = {
  grant: 1.5,
  relay: 1.5,
  use: 1.4,
  reply: 1.0,
  hold: 1.1,
};
const NEXT: Record<Phase, Phase> = {
  grant: "relay",
  relay: "use",
  use: "reply",
  reply: "hold",
  hold: "grant",
};

interface Cast {
  /** A to B, B to C, then C back to A. Node indices, positions read live. */
  grant: number[];
  relay: number[];
  use: number[];
  gen: number[];
}

export function relay(): Scene {
  const field = new Field();
  let cast: Cast | null = null;
  let phase: Phase = "grant";
  let p = 0;
  let age = 0;

  /**
   * Cast three parties such that A-B and B-C are connected, and C can reach A.
   *
   * All three legs have to exist in the *current* field or the story cannot be
   * told, so this is a search that is allowed to fail: on a sparse frame nothing
   * is cast and the field simply drifts until it can be.
   */
  const castParties = (): Cast | null => {
    for (let attempt = 0; attempt < 12; attempt++) {
      // Start from the end of a wide route, so the three parties are spread
      // across the hero rather than clustered in one corner of the field.
      const seed = field.findSpanningPath(3, 4, 6);
      const a = seed ? seed[0]! : Math.floor(Math.random() * field.nodes.length);
      const grant = field.findPath(3, 4, a);
      if (!grant) continue;
      const b = grant[grant.length - 1]!;
      const relayLeg = field.findPath(3, 4, b);
      if (!relayLeg) continue;
      const c = relayLeg[relayLeg.length - 1]!;
      if (c === a || grant.includes(c)) continue;
      const use = field.pathTo(c, a, 8);
      if (!use || use.length < 3) continue;
      const all = [...new Set([...grant, ...relayLeg, ...use])];
      return { grant, relay: relayLeg, use, gen: field.gensOf(all) };
    }
    return null;
  };

  const allNodes = (k: Cast) => [...new Set([...k.grant, ...k.relay, ...k.use])];

  /** The open diamond that *is* the capability, wherever it currently sits. */
  const drawToken = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    colour: string,
    alpha: number,
    r: number,
  ) => {
    const m = field.clarity(x, y) * alpha;
    if (m <= 0.01) return;
    ctx.globalAlpha = m;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  return {
    ambient: true,
    layout(s: SceneSize) {
      field.layout(s);
      if (cast && allNodes(cast).some((i) => i >= field.nodes.length)) cast = null;
    },
    draw(c) {
      const { ctx, palette } = c;
      field.clarity = c.keepOut.clarity;

      if (!c.still) {
        field.advance(c.dt);
        age += c.dt;
        p += c.dt / DUR[phase];
        if (p >= 1) {
          p = 0;
          phase = NEXT[phase];
          // One full circuit per cast, so the parties change between stories.
          if (phase === "grant") cast = null;
        }
      } else if (!cast) {
        // The composed still: the moment C calls A, with both earlier legs drawn.
        phase = "use";
        p = 0.55;
      }

      if (!cast) {
        cast = castParties();
        if (cast) age = 0;
      }
      // A node under the cast wrapped to the far edge, so its routes are nonsense.
      if (cast && field.wrapped(allNodes(cast), cast.gen)) cast = null;

      field.draw(ctx, palette);
      if (!cast) return;

      const fade = c.still ? 1 : Math.min(1, age / 0.4);
      const a = cast.grant[0]!;
      const b = cast.grant[cast.grant.length - 1]!;
      const cc = cast.relay[cast.relay.length - 1]!;
      const done = (ph: Phase) => Object.keys(DUR).indexOf(phase) > Object.keys(DUR).indexOf(ph);

      // Routes that have already carried the token stay faintly lit, so by the end
      // the whole chain of custody is visible at once.
      field.drawRoute(ctx, palette, cast.grant, (done("grant") ? 0.3 : 0.55) * fade);
      if (phase !== "grant") field.drawRoute(ctx, palette, cast.relay, (done("relay") ? 0.3 : 0.55) * fade);
      if (done("relay")) {
        // The route C uses to reach A, drawn in the request colour: it is new, and
        // it is the leg that has no prior relationship behind it.
        field.drawRoute(ctx, palette, cast.use, 0.55 * fade, palette.request);
      }

      field.drawEndpoint(ctx, a, palette.request, 0, fade);
      field.drawEndpoint(ctx, b, palette.stroke, 0, fade);
      field.drawEndpoint(ctx, cc, done("relay") ? palette.request : palette.stroke, 0, fade);

      const ease = p * p * (3 - 2 * p);
      if (phase === "grant" || phase === "relay") {
        // The token in transit, handed from one holder to the next.
        const leg = phase === "grant" ? cast.grant : cast.relay;
        const total = field.pathLength(leg);
        const pt = field.pointAt(leg, total * ease);
        drawToken(ctx, pt.x, pt.y, palette.response, fade, 6);
      } else {
        // Held by C from here on, pulsing gently: it is C's to use now.
        const held = field.nodes[cc]!;
        const pulse = 6 + Math.sin(age * 3) * 0.9;
        drawToken(ctx, held.x, held.y, palette.response, fade, pulse);
      }

      if (phase === "use") {
        // C exercises the capability against A. A train, as ever: one trip.
        const total = field.pathLength(cast.use);
        const head = total * ease;
        for (let k = 0; k < 4; k++) {
          const d = head - k * 11;
          if (d < 0) continue;
          field.dot(ctx, field.pointAt(cast.use, d), palette.request, fade * (1 - k / 5) * 0.95, 1.6);
        }
      } else if (phase === "reply") {
        // A honours it, because the authority is genuine however far it travelled.
        const total = field.pathLength(cast.use);
        const pt = field.pointAt(cast.use, total * (1 - ease));
        field.dot(ctx, pt, palette.response, fade, 2);
        field.drawEndpoint(ctx, a, palette.response, Math.sin(p * Math.PI), fade);
      }
    },
  };
}
