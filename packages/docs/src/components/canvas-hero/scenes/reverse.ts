/**
 * Scene 1b: one route, and the direction of calls reverses on it.
 *
 * A calls B and B answers, which is the shape everyone expects. Then nothing is
 * torn down and nothing is dialled: B calls A along the identical route, and A
 * answers. The two halves are drawn the same way in the same colours, mirrored,
 * so the only difference the eye can find is which end started it.
 *
 * The colours carry the argument. A call is always the request colour and always
 * a train; an answer is always the response colour and always a single mark. So
 * the second half is unmistakably a *call* travelling right to left, not a late
 * reply -- there is no such thing as a client and a server here, only two peers
 * that happen to take turns.
 *
 * Docs: `concepts/rpc-target.md` (both ends export interfaces),
 * `guides/sessions.md` (bidirectional by default).
 */
import type { Scene, SceneSize } from "../types";
import { Field } from "./field";

/** One direction's story, then the other's. `turn` flips at each cycle's end. */
type Phase = "call" | "work" | "answer" | "settle";

const DUR: Record<Phase, number> = { call: 1.35, work: 0.26, answer: 1.0, settle: 0.5 };
const NEXT: Record<Phase, Phase> = { call: "work", work: "answer", answer: "settle", settle: "call" };

export function reverse(): Scene {
  const field = new Field();
  let route: number[] | null = null;
  let gen: number[] = [];
  let phase: Phase = "call";
  let p = 0;
  let age = 0;
  /** 0 = the left end is calling, 1 = the right end is. */
  let turn = 0;
  /** Cycles completed on this route, so a route is not reused indefinitely. */
  let cycles = 0;

  const pick = () => {
    const path = field.findSpanningPath(4, 5, 8);
    if (!path) return;
    route = path;
    gen = field.gensOf(path);
    age = 0;
    cycles = 0;
  };

  return {
    ambient: true,
    layout(s: SceneSize) {
      field.layout(s);
      if (route && route.some((i) => i >= field.nodes.length)) route = null;
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
          if (phase === "call") {
            // The turn passes. This is the whole scene.
            turn ^= 1;
            cycles++;
            if (cycles >= 4) route = null;
          }
        }
      } else if (!route) {
        // The still shows the reversed half in flight: the surprising one.
        turn = 1;
        phase = "call";
        p = 0.6;
      }

      if (!route) pick();
      if (route && field.wrapped(route, gen)) route = null;

      field.draw(ctx, palette);
      if (!route) return;

      const fade = c.still ? 1 : Math.min(1, age / 0.4);
      // The route is read forwards or backwards depending on whose turn it is, so
      // every calculation below is written once and simply runs mirrored.
      const path = turn === 0 ? route : [...route].reverse();
      const caller = path[0]!;
      const callee = path[path.length - 1]!;
      const total = field.pathLength(path);
      const ease = p * p * (3 - 2 * p);

      field.drawRoute(ctx, palette, route, 0.5 * fade);

      // The caller wears the request colour, the callee the response colour, and
      // both swap over at the turn. Nothing else about them changes.
      field.drawEndpoint(ctx, caller, palette.request, 0, fade);
      field.drawEndpoint(
        ctx,
        callee,
        phase === "work" ? palette.response : palette.stroke,
        phase === "work" ? Math.sin(p * Math.PI) : 0,
        fade,
      );

      if (phase === "call") {
        for (let k = 0; k < 4; k++) {
          const d = total * ease - k * 11;
          if (d < 0) continue;
          field.dot(ctx, field.pointAt(path, d), palette.request, fade * (1 - k / 5) * 0.95, 1.6);
        }
      } else if (phase === "answer") {
        const pt = field.pointAt(path, total * (1 - ease));
        field.dot(ctx, pt, palette.response, fade, 2);
        const tail = field.pointAt(path, Math.min(total, total * (1 - ease) + 14));
        const m = field.clarity(pt.x, pt.y);
        ctx.strokeStyle = palette.response;
        ctx.globalAlpha = fade * 0.5 * m;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(tail.x, tail.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (phase === "settle") {
        // A ring opening at the end that is about to take over, which is the only
        // cue that the next thing to happen is a reversal rather than a repeat.
        const n = field.nodes[callee]!;
        const m = field.clarity(n.x, n.y) * fade;
        if (m > 0.01) {
          ctx.globalAlpha = m * (1 - p) * 0.7;
          ctx.strokeStyle = palette.request;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 5 + p * 12, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    },
  };
}
