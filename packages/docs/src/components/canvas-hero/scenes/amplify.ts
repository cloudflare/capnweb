/**
 * Scene 1d: one call in, a detonation in the middle, one value out.
 *
 * A single request arrives at a node. What leaves the other side is also a single
 * value, and the two are the same size, drawn the same way, a couple of seconds
 * apart. Between them the call fans out through the field one level at a time
 * until most of the canvas is lit, then collapses back to nothing.
 *
 * The asymmetry is the entire argument. A server that meters what it receives and
 * what it returns sees two small things and concludes it was a small request. The
 * cost is in the middle, where nobody is looking, and it grows by a factor per
 * level rather than by an increment -- which is why the wave visibly accelerates
 * outward and why the third level fills the field when the first was four nodes.
 *
 * Docs: `guides/security.md` (amplification and resource limits), `concepts/map.md`
 * (a callback the server runs, once per element).
 */
import type { Scene, SceneSize } from "../types";
import { Field } from "./field";

type Phase = "arrive" | "expand" | "peak" | "collapse" | "leave" | "rest";

const DUR: Record<Phase, number> = {
  arrive: 1.0,
  expand: 1.5,
  peak: 0.4,
  collapse: 1.2,
  leave: 1.0,
  rest: 0.7,
};
const NEXT: Record<Phase, Phase> = {
  arrive: "expand",
  expand: "peak",
  peak: "collapse",
  collapse: "leave",
  leave: "rest",
  rest: "arrive",
};

/** How many levels the blast walks. Three is enough to fill a hero. */
const LEVELS = 3;

interface Blast {
  /** The caller's route into the root. One request travels this. */
  approach: number[];
  /** Node indices by distance from the root, root at index 0. */
  levels: number[][];
  /** Child to parent, for drawing each edge of the tree. */
  parent: Map<number, number>;
  gen: number[];
}

export function amplify(): Scene {
  const field = new Field();
  let blast: Blast | null = null;
  let phase: Phase = "arrive";
  let p = 0;
  let age = 0;

  const allNodes = (b: Blast) => [...new Set([...b.approach, ...b.levels.flat()])];

  const build = (): Blast | null => {
    const approach = field.findPath(2, 3);
    if (!approach) return null;
    const root = approach[approach.length - 1]!;
    const seen = new Set<number>([root]);
    const levels: number[][] = [[root]];
    const parent = new Map<number, number>();
    for (let k = 1; k <= LEVELS; k++) {
      const next: number[] = [];
      for (const i of levels[k - 1]!) {
        for (const j of field.neighbours(i)) {
          if (seen.has(j)) continue;
          seen.add(j);
          parent.set(j, i);
          next.push(j);
        }
      }
      if (next.length === 0) break;
      levels.push(next);
    }
    // Two levels is the minimum that reads as growth rather than a star.
    if (levels.length < 3) return null;
    const b: Blast = { approach, levels, parent, gen: [] };
    b.gen = field.gensOf(allNodes(b));
    return b;
  };

  return {
    ambient: true,
    layout(s: SceneSize) {
      field.layout(s);
      if (blast && allNodes(blast).some((i) => i >= field.nodes.length)) blast = null;
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
          if (phase === "arrive") blast = null;
        }
      } else if (!blast) {
        // The still is the peak: the small arrival still visible, the field full.
        phase = "peak";
        p = 0.5;
      }

      if (!blast) {
        blast = build();
        if (blast) age = 0;
      }
      if (blast && field.wrapped(allNodes(blast), blast.gen)) blast = null;

      field.draw(ctx, palette);
      if (!blast) return;

      const fade = c.still ? 1 : Math.min(1, age / 0.35);
      const root = blast.levels[0]![0]!;
      const caller = blast.approach[0]!;
      const depth = blast.levels.length - 1;

      /**
       * How far the wave has travelled, in levels.
       *
       * Expansion eases *in* rather than out: each level has more nodes than the
       * last, so a constant rate would look like it was slowing down. Collapse runs
       * the same curve backwards.
       */
      const wave =
        phase === "expand"
          ? depth * (p * p)
          : phase === "peak"
            ? depth
            : phase === "collapse"
              ? depth * (1 - p * p)
              : phase === "arrive"
                ? 0
                : 0;

      field.drawRoute(ctx, palette, blast.approach, 0.3 * fade);
      field.drawEndpoint(ctx, caller, palette.request, 0, fade);

      if (wave > 0) {
        // The tree, level by level. Each edge fills as the wave passes it and the
        // colour walks from request to response as the blast turns into results.
        ctx.lineWidth = 1.2;
        for (let k = 1; k < blast.levels.length; k++) {
          const front = Math.max(0, Math.min(1, wave - (k - 1)));
          if (front <= 0) continue;
          for (const child of blast.levels[k]!) {
            const a = field.nodes[blast.parent.get(child)!];
            const b = field.nodes[child];
            if (!a || !b) continue;
            const m = field.lineClarity(a, b);
            if (m <= 0.01) continue;
            ctx.globalAlpha = 0.5 * fade * m * front;
            ctx.strokeStyle = palette.request;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(a.x + (b.x - a.x) * front, a.y + (b.y - a.y) * front);
            ctx.stroke();
            if (front >= 0.999) {
              // A lit node at the tip of every completed edge: the work being done.
              field.dot(ctx, b, palette.response, fade * 0.85, 2);
            }
          }
        }
        ctx.globalAlpha = 1;
      }

      field.drawEndpoint(
        ctx,
        root,
        wave > 0 ? palette.response : palette.stroke,
        phase === "peak" ? 1 : wave / Math.max(1, depth),
        fade,
      );

      const total = field.pathLength(blast.approach);
      const ease = p * p * (3 - 2 * p);
      if (phase === "arrive") {
        // One mark. The same size as the one that leaves.
        field.dot(ctx, field.pointAt(blast.approach, total * ease), palette.request, fade, 2);
      } else if (phase === "leave") {
        field.dot(ctx, field.pointAt(blast.approach, total * (1 - ease)), palette.response, fade, 2);
      }
    },
  };
}
