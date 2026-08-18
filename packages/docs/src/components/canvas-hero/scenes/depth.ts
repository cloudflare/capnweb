/**
 * Scene 6: four dependent calls, done the slow way and the pipelined way, racing.
 *
 * Two lanes, same four calls, same network, started in the same frame. The upper
 * lane waits for each answer before it can ask the next question, so it crosses
 * the gap eight times. The lower lane sends all four at once, because a call that
 * depends on a previous call's *result* does not have to wait for that result to
 * come home -- it can name it. It crosses twice.
 *
 * The lower lane finishes early and then does nothing at all, holding a settled
 * mark at the near end while the upper lane is still on its second or third trip.
 * That stretch of doing nothing is the whole scene: it is the same idle time the
 * tour measures as "400 ms of doing nothing", drawn to scale rather than
 * described. Depth costs latency only if you make it.
 *
 * Docs: `start/pipelining-tour.md` (four dependent calls, one round trip),
 * `concepts/promises.md` (awaiting is what costs a round trip).
 */
import type { Scene, SceneSize } from "../types";
import { Field } from "./field";
import { endpost, MIN_PITCH, stage, type Stage } from "./stage";

/** Calls in the chain. The tour's example is a chain of four. */
const CALLS = 4;
/** Seconds for one crossing of the gap. */
const LEG = 0.62;
/** The far end's turnaround, per call. */
const WORK = 0.1;
/** How long the finished picture holds before the loop restarts. */
const HOLD = 1.4;

/** The naive lane: out, work, back, for each call in turn. */
const NAIVE_TOTAL = CALLS * (LEG * 2 + WORK);
/** The pipelined lane: one out, one turnaround, one back. */
const PIPED_TOTAL = LEG * 2 + WORK;
const CYCLE = NAIVE_TOTAL + HOLD;

export function depth(): Scene {
  const field = new Field(34);
  let st: Stage | null = null;
  let ok = false;
  let clock = 0;

  /**
   * Where the naive lane is at time `t`: which call, and how far through it.
   *
   * Returns null once the lane has finished, which is when it stops drawing
   * anything moving and the comparison is over.
   */
  const naiveAt = (t: number) => {
    const per = LEG * 2 + WORK;
    const index = Math.floor(t / per);
    if (index >= CALLS) return null;
    const local = t - index * per;
    if (local < LEG) return { index, phase: "out" as const, p: local / LEG };
    if (local < LEG + WORK) return { index, phase: "work" as const, p: (local - LEG) / WORK };
    return { index, phase: "back" as const, p: (local - LEG - WORK) / LEG };
  };

  const drawLane = (
    ctx: CanvasRenderingContext2D,
    s: Stage,
    y: number,
    colour: string,
    alpha: number,
  ) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x0, y);
    ctx.lineTo(s.x1, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  const mark = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    colour: string,
    alpha: number,
    r = 2,
  ) => {
    if (alpha <= 0.01) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  };

  return {
    ambient: true,
    layout(size: SceneSize, keepOut) {
      field.layout(size);
      st = stage(size, keepOut, 2);
      // Two lanes need real vertical room. Below that the harness swaps in the
      // field rather than showing two lines on top of each other.
      ok = st.pitch >= MIN_PITCH && st.span > 240;
    },
    fits: () => ok,
    draw(c) {
      const { ctx, palette } = c;
      field.clarity = c.keepOut.clarity;
      if (!st) return;
      const s = st;

      if (c.still) {
        // The composed still is the moment the argument is clearest: the pipelined
        // lane already settled, the naive lane barely half done.
        clock = PIPED_TOTAL + (NAIVE_TOTAL - PIPED_TOTAL) * 0.45;
      } else {
        field.advance(c.dt);
        clock = (clock + c.dt) % CYCLE;
      }

      // The field is body here, not content, so it sits well back.
      field.draw(ctx, palette, 0.45);

      const half = Math.min(7, s.pitch * 0.32);
      const yN = s.lanes[0]!;
      const yP = s.lanes[1]!;

      for (const y of [yN, yP]) {
        drawLane(ctx, s, y, `rgb(${palette.strokeRgb})`, palette.light ? 0.34 : 0.28);
        endpost(ctx, s.x0, y, half, `rgb(${palette.strokeRgb})`, 0.55);
        endpost(ctx, s.x1, y, half, `rgb(${palette.strokeRgb})`, 0.55);
      }

      // Upper lane: one call in flight at a time, and the marks it has banked.
      const n = naiveAt(clock);
      for (let i = 0; i < CALLS; i++) {
        const settled = n === null || i < n.index;
        if (settled) mark(ctx, s.x0 + 5 + i * 7, yN - half - 5, palette.response, 0.75, 1.6);
      }
      if (n) {
        if (n.phase === "out") {
          mark(ctx, s.x0 + s.span * n.p, yN, palette.request, 0.95);
        } else if (n.phase === "work") {
          endpost(ctx, s.x1, yN, half + 2, palette.response, Math.sin(n.p * Math.PI));
        } else {
          mark(ctx, s.x1 - s.span * n.p, yN, palette.response, 0.95);
        }
      }

      // Lower lane: all four leave together, one turnaround, one value comes back.
      const t = clock;
      if (t < LEG) {
        for (let k = 0; k < CALLS; k++) {
          const d = s.span * (t / LEG) - k * 10;
          if (d < 0) continue;
          mark(ctx, s.x0 + d, yP, palette.request, 0.95 * (1 - k / (CALLS + 2)), 1.7);
        }
      } else if (t < LEG + WORK) {
        // One turnaround for the whole chain: the far end resolves all four.
        endpost(ctx, s.x1, yP, half + 2, palette.response, Math.sin(((t - LEG) / WORK) * Math.PI));
      } else if (t < PIPED_TOTAL) {
        mark(ctx, s.x1 - s.span * ((t - LEG - WORK) / LEG), yP, palette.response, 0.95);
      }
      if (t >= PIPED_TOTAL) {
        // Settled, and then simply waiting. The mark does not move again.
        for (let i = 0; i < CALLS; i++) {
          mark(ctx, s.x0 + 5 + i * 7, yP - half - 5, palette.response, 0.75, 1.6);
        }
        // A quiet bar growing along the lower lane for exactly as long as it is
        // idle, which is the difference between the two strategies made visible.
        const idle = Math.min(1, (t - PIPED_TOTAL) / (NAIVE_TOTAL - PIPED_TOTAL));
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = palette.response;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(s.x0, yP + half + 4);
        ctx.lineTo(s.x0 + s.span * idle, yP + half + 4);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    },
  };
}
