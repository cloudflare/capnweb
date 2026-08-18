/**
 * Scene 1c: a session dies, and everything it was holding dies with it.
 *
 * A hub holds a handful of live stubs, drawn as rings on the far end of each
 * spoke, with traffic ticking along them. Then the session drops. Every ring
 * breaks in the same frame -- not one after another, not the nearest first --
 * because they were never independent things; they were all names on one
 * connection, and the connection is what went away. The field goes bare for a
 * beat, which is the honest picture of what a caller is left holding.
 *
 * Then a new hub lights somewhere else and the spokes grow back one at a time.
 * Recovery is deliberately slower than loss and visibly sequential, because
 * reconnecting is work and losing is not.
 *
 * Docs: `concepts/disposal.md` (a broken session breaks every stub on it),
 * `guides/sessions.md` (lifetime is the connection's lifetime).
 */
import type { Scene, SceneSize } from "../types";
import { Field } from "./field";

type Phase = "live" | "die" | "dark" | "grow";

const DUR: Record<Phase, number> = { live: 3.0, die: 1.05, dark: 0.9, grow: 2.2 };
const NEXT: Record<Phase, Phase> = { live: "die", die: "dark", dark: "grow", grow: "live" };

interface Spoke {
  /** Hub first, stub last. */
  path: number[];
  /** Staggers both the idle traffic and the regrowth order. */
  offset: number;
}

export function sessionLoss(): Scene {
  const field = new Field();
  let hub = -1;
  let spokes: Spoke[] = [];
  let gen: number[] = [];
  let phase: Phase = "live";
  let p = 0;
  let age = 0;

  const nodesInUse = () => [hub, ...spokes.flatMap((s) => s.path)];

  /** A hub with three to five reachable stubs, or nothing if the field is thin. */
  const build = () => {
    spokes = [];
    hub = -1;
    for (let attempt = 0; attempt < 10 && spokes.length < 3; attempt++) {
      // Hub the session on the middle of a wide route, so its spokes reach out
      // across the hero instead of bunching into one corner.
      const seed = field.findSpanningPath(3, 4, 6);
      const h = seed ? seed[Math.floor(seed.length / 2)]! : Math.floor(Math.random() * field.nodes.length);
      const found: Spoke[] = [];
      const taken = new Set<number>([h]);
      for (let k = 0; k < 12 && found.length < 6; k++) {
        const path = field.findPath(3, 4, h);
        if (!path) continue;
        const tip = path[path.length - 1]!;
        if (taken.has(tip)) continue;
        taken.add(tip);
        found.push({ path, offset: found.length * 0.37 });
      }
      if (found.length >= 3) {
        hub = h;
        spokes = found;
      }
    }
    if (hub >= 0) {
      gen = field.gensOf(nodesInUse());
      age = 0;
    }
  };

  /** A ring with a gap in it: a stub that is no longer connected to anything. */
  const drawBroken = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    colour: string,
    alpha: number,
    grow: number,
  ) => {
    const m = field.clarity(x, y) * alpha;
    if (m <= 0.01) return;
    ctx.globalAlpha = m;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.6;
    const r = 6 + grow * 10;
    // The gap widens as it goes, so the ring visibly comes apart rather than
    // just fading, which would read as "finished" instead of "broken".
    const gap = 0.25 + grow * 1.1;
    for (const start of [gap, Math.PI + gap]) {
      ctx.beginPath();
      ctx.arc(x, y, r, start, start + Math.PI - gap * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  return {
    ambient: true,
    layout(s: SceneSize) {
      field.layout(s);
      if (hub >= 0 && nodesInUse().some((i) => i >= field.nodes.length)) hub = -1;
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
          // The session that comes back is a different one, in a different place.
          if (phase === "grow") hub = -1;
        }
      } else if (hub < 0) {
        // The still is the instant of loss: rings coming apart, spokes retreating.
        phase = "die";
        p = 0.5;
      }

      if (hub < 0) {
        build();
        // `build` runs during `dark`/`grow`, so do not let a fresh cast appear
        // mid-collapse with its rings intact.
        if (phase === "die") phase = "dark";
      }
      // A wrap is retired in every phase, `die` included. Exempting the collapse
      // to keep it from being interrupted meant a spoke whose tip wrapped mid-death
      // was drawn from the hub to the far edge of the canvas: a 1179px segment, in
      // the one phase the eye is meant to be following. Cutting the collapse short
      // and going dark is the lesser fault, and it lands on a frame that is already
      // supposed to be emptying out.
      if (hub >= 0 && field.wrapped(nodesInUse(), gen)) hub = -1;

      // The whole field dims while the session is down, so the loss is felt in the
      // background too and not only along the spokes.
      const dim = phase === "dark" ? 0.55 + 0.45 * p : phase === "die" ? 1 - 0.45 * p : 1;
      field.draw(ctx, palette, dim);
      if (hub < 0) return;

      const fade = c.still ? 1 : Math.min(1, age / 0.4);
      const alive = phase === "live" || phase === "grow";

      for (let i = 0; i < spokes.length; i++) {
        const spoke = spokes[i]!;
        const tip = spoke.path[spoke.path.length - 1]!;
        const n = field.nodes[tip];
        if (!n) continue;
        const total = field.pathLength(spoke.path);

        // During regrowth each spoke arrives in its own time. Everywhere else the
        // whole set shares one value, which is exactly the point at `die`.
        const grown =
          phase === "grow"
            ? Math.max(0, Math.min(1, (p - i * 0.16) / 0.42))
            : phase === "live"
              ? 1
              : phase === "die"
                ? 1 - p
                : 0;
        if (grown <= 0.001) continue;

        // The spoke itself, drawn only as far as it has grown or retreated.
        ctx.lineWidth = 1;
        let travelled = 0;
        for (let k = 1; k < spoke.path.length; k++) {
          const a = field.nodes[spoke.path[k - 1]!]!;
          const b = field.nodes[spoke.path[k]!]!;
          const seg = Math.hypot(b.x - a.x, b.y - a.y);
          const from = travelled / total;
          const to = (travelled + seg) / total;
          travelled += seg;
          if (from >= grown) break;
          const f = Math.min(1, (grown - from) / Math.max(1e-6, to - from));
          const m = field.lineClarity(a, b);
          if (m <= 0.01) continue;
          ctx.globalAlpha = 0.52 * fade * m * (phase === "die" ? 0.9 : 1);
          ctx.strokeStyle = phase === "die" ? palette.fade : `rgb(${palette.strokeRgb})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        if (phase === "die") {
          // Every ring, same frame, same amount. No stagger anywhere in here.
          drawBroken(ctx, n.x, n.y, palette.fade, fade * (1 - p * 0.45), p);
        } else if (grown >= 0.999) {
          field.drawEndpoint(ctx, tip, palette.stroke, 0, fade);
          if (alive && phase === "live") {
            // Idle chatter, so the session reads as in use rather than merely drawn.
            const t = (age * 0.55 + spoke.offset) % 1;
            field.dot(ctx, field.pointAt(spoke.path, total * t), palette.request, fade * 0.8, 1.5);
          }
        }
      }

      // The hub last, on top of its own spokes.
      if (phase === "die") {
        const n = field.nodes[hub]!;
        const m = field.clarity(n.x, n.y) * fade;
        if (m > 0.01) {
          ctx.globalAlpha = m * (1 - p);
          ctx.fillStyle = palette.fade;
          ctx.fillRect(n.x - 3, n.y - 3, 6, 6);
          ctx.globalAlpha = 1;
        }
      } else if (phase !== "dark") {
        const settling = phase === "grow" ? Math.min(1, p / 0.2) : 1;
        field.drawEndpoint(ctx, hub, palette.request, 0, fade * settling);
      }
    },
  };
}
