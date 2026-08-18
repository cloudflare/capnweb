/**
 * Scene 7: three calls ship with holes in them, and the holes are filled at the
 * far end by each other's results.
 *
 * Three dependent calls leave together. The first carries a real argument, drawn
 * solid. The second and third each carry an open ring: an argument their sender
 * does not have and cannot supply, because it is the result of a call that has
 * not been answered yet. They are sent anyway.
 *
 * At the far end the chain resolves downward. The first call runs, and its result
 * drops into the second call's ring along a short vertical link -- the only
 * movement in the scene that is not horizontal, because it is the only movement
 * that is not on the wire. Then the second runs and fills the third. Then one
 * value, the last one, makes the return trip. The two intermediate results never
 * travel at all; they are born and consumed at the same end.
 *
 * That vertical hop is the whole idea. Pipelining is not the calls being sent
 * quickly, it is the arguments being resolved where the data already is.
 *
 * Docs: `concepts/promises.md` (a promise used as an argument),
 * `reference/protocol.md` (`["pipeline", importId, path, args]`).
 */
import type { Scene, SceneSize } from "../types";
import { Field } from "./field";
import { endpost, MIN_PITCH, stage, type Stage } from "./stage";

/** Calls in the chain. Each one after the first depends on the one above it. */
const LINKS = 3;

const LEG = 1.7;
/**
 * Stagger between departures.
 *
 * Small, because all three ride one trip -- but not zero: with the calls exactly
 * superimposed the three rings crossing the hero read as one, and the fact that
 * there are three separate messages in flight is half the picture.
 */
const STEP = 0.28;
/** Per link at the far end: the flash, then the handoff into the next ring. */
const RUN = 0.2;
const HAND = 0.34;
const CHAIN = LINKS * (RUN + HAND);
const OUT_END = (LINKS - 1) * STEP + LEG;
const BACK_END = OUT_END + CHAIN + LEG;
const CYCLE = BACK_END + 0.9;

export function substitute(): Scene {
  const field = new Field(34);
  let st: Stage | null = null;
  let ok = false;
  let clock = 0;

  /**
   * How full link `i`'s argument ring is, 0 to 1.
   *
   * The first link's argument is concrete from the start. Every other link's is
   * empty until the link above it has run and handed its result down.
   */
  const filled = (i: number, t: number): number => {
    if (i === 0) return 1;
    const handStart = OUT_END + (i - 1) * (RUN + HAND) + RUN;
    return Math.max(0, Math.min(1, (t - handStart) / HAND));
  };

  /** The travelling call: a solid body and an argument ring beside it. */
  const drawCall = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    request: string,
    response: string,
    fill: number,
    alpha: number,
  ) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = request;
    ctx.fillRect(x - 6, y - 2, 4, 4);
    ctx.strokeStyle = fill > 0 ? response : request;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(x + 1.5, y, 3.6, 0, Math.PI * 2);
    ctx.stroke();
    if (fill > 0) {
      ctx.globalAlpha = alpha * fill;
      ctx.fillStyle = response;
      ctx.beginPath();
      ctx.arc(x + 1.5, y, 2.4 * fill, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  return {
    ambient: true,
    layout(size: SceneSize, keepOut) {
      field.layout(size);
      st = stage(size, keepOut, LINKS);
      ok = st.pitch >= MIN_PITCH && st.span > 240;
    },
    fits: () => ok,
    draw(c) {
      const { ctx, palette } = c;
      field.clarity = c.keepOut.clarity;
      if (!st) return;
      const s = st;

      if (c.still) {
        // The still is caught on the second handoff: one ring already filled, one
        // filling, and the third still open. The mechanism in one frame.
        clock = OUT_END + RUN + HAND * 0.6 + (RUN + HAND);
      } else {
        field.advance(c.dt);
        clock = (clock + c.dt) % CYCLE;
      }
      const t = clock;

      field.draw(ctx, palette, 0.45);

      const half = Math.min(7, s.pitch * 0.32);
      const strokeCss = `rgb(${palette.strokeRgb})`;

      for (let i = 0; i < LINKS; i++) {
        const y = s.lanes[i]!;
        ctx.globalAlpha = palette.light ? 0.34 : 0.28;
        ctx.strokeStyle = strokeCss;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s.x0, y);
        ctx.lineTo(s.x1, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        endpost(ctx, s.x0, y, half, strokeCss, 0.5);
        endpost(ctx, s.x1, y, half, strokeCss, 0.5);
      }

      // The vertical handoffs at the far post. Drawn before the calls so the
      // ring sits on top of the link that is filling it.
      for (let i = 0; i < LINKS - 1; i++) {
        const from = s.lanes[i]!;
        const to = s.lanes[i + 1]!;
        const handStart = OUT_END + i * (RUN + HAND) + RUN;
        const g = Math.max(0, Math.min(1, (t - handStart) / HAND));
        if (g <= 0) continue;
        ctx.globalAlpha = 0.75 * (t > handStart + HAND ? 0.4 : 1);
        ctx.strokeStyle = palette.response;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(s.x1, from);
        ctx.lineTo(s.x1, from + (to - from) * g);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      for (let i = 0; i < LINKS; i++) {
        const y = s.lanes[i]!;
        const depart = i * STEP;
        const arrive = depart + LEG;
        const runStart = OUT_END + i * (RUN + HAND);
        const fill = filled(i, t);

        if (t < depart) continue;

        if (t < arrive) {
          // Outbound, holes and all.
          const ease = (t - depart) / LEG;
          drawCall(ctx, s.x0 + s.span * ease, y, palette.request, palette.response, fill, 0.95);
        } else if (t < runStart) {
          // Landed, waiting for its argument to exist. Nothing is being awaited on
          // the caller's side; the message is simply parked at the far end.
          drawCall(ctx, s.x1 - 8, y, palette.request, palette.response, fill, 0.95);
        } else if (t < runStart + RUN) {
          drawCall(ctx, s.x1 - 8, y, palette.request, palette.response, 1, 0.95);
          endpost(ctx, s.x1, y, half + 2, palette.response, Math.sin(((t - runStart) / RUN) * Math.PI));
        } else if (i < LINKS - 1) {
          // Done, and its result is going sideways rather than home.
          drawCall(ctx, s.x1 - 8, y, palette.request, palette.response, 1, 0.4);
        }
      }

      // One value returns, on the last lane only.
      const backStart = OUT_END + CHAIN;
      const yLast = s.lanes[LINKS - 1]!;
      if (t >= backStart && t < backStart + LEG) {
        const ease = (t - backStart) / LEG;
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = palette.response;
        const x = s.x1 - s.span * ease;
        ctx.fillRect(x - 2.5, yLast - 2.5, 5, 5);
        ctx.globalAlpha = 1;
      } else if (t >= backStart + LEG) {
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = palette.response;
        ctx.fillRect(s.x0 - 2.5, yLast - 2.5, 5, 5);
        ctx.globalAlpha = 1;
      }
    },
  };
}
