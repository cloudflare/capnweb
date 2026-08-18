/**
 * Scene 8: five calls go out, and two answers come back.
 *
 * Every call in the batch is real. Each one crosses, lands, and runs at the far
 * end -- all five flash. But only the two the caller actually awaited are pulled,
 * so only two answers make the return trip. The other three end where they ran:
 * the tooth stops at the far post and dims out.
 *
 * The gap in the returning comb is the point. Intermediate results in a pipelined
 * chain are named, used, and never shipped; the wire only carries what somebody
 * is waiting on. A protocol that returned all five would be paying for four values
 * that get dropped on arrival.
 *
 * Docs: `reference/protocol.md` (`["pull", importId]` is sent only for awaited
 * values), `concepts/promises.md` (awaiting is what costs a round trip).
 */
import type { Scene, SceneSize } from "../types";
import { Field } from "./field";
import { endpost, MIN_PITCH, stage, type Stage } from "./stage";

/** Calls in the batch. */
const TEETH = 5;
/** Which of them were awaited, and therefore pulled. */
const PULLED = new Set([1, 4]);

const LEG = 0.72;
const WORK = 0.22;
/** Stagger between successive calls in the batch. They ride one trip, not five. */
const STEP = 0.075;
const HOLD = 1.5;
const CYCLE = (TEETH - 1) * STEP + LEG + WORK + LEG + HOLD;

export function unpulled(): Scene {
  const field = new Field(34);
  let st: Stage | null = null;
  let ok = false;
  let clock = 0;

  return {
    ambient: true,
    layout(size: SceneSize, keepOut) {
      field.layout(size);
      st = stage(size, keepOut, TEETH);
      ok = st.pitch >= MIN_PITCH && st.span > 240;
    },
    fits: () => ok,
    draw(c) {
      const { ctx, palette } = c;
      field.clarity = c.keepOut.clarity;
      if (!st) return;
      const s = st;

      if (c.still) {
        // The still is caught on the return leg, where the comb has its gaps.
        clock = (TEETH - 1) * STEP + LEG + WORK + LEG * 0.55;
      } else {
        field.advance(c.dt);
        clock = (clock + c.dt) % CYCLE;
      }

      field.draw(ctx, palette, 0.45);

      const half = Math.min(6, s.pitch * 0.3);
      const strokeCss = `rgb(${palette.strokeRgb})`;

      for (let i = 0; i < TEETH; i++) {
        const y = s.lanes[i]!;
        const pulled = PULLED.has(i);
        const t = clock - i * STEP;

        ctx.globalAlpha = palette.light ? 0.3 : 0.24;
        ctx.strokeStyle = strokeCss;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s.x0, y);
        ctx.lineTo(s.x1, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        endpost(ctx, s.x0, y, half, strokeCss, 0.5);
        endpost(ctx, s.x1, y, half, strokeCss, 0.5);

        if (t < 0) continue;

        if (t < LEG) {
          // Outbound. Every tooth, no exceptions: all five calls are sent.
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = palette.request;
          const x = s.x0 + s.span * (t / LEG);
          ctx.fillRect(x - 1.8, y - 1.8, 3.6, 3.6);
          ctx.globalAlpha = 1;
        } else if (t < LEG + WORK) {
          // Every tooth runs at the far end, pulled or not.
          endpost(ctx, s.x1, y, half + 2, palette.response, Math.sin(((t - LEG) / WORK) * Math.PI));
        } else if (t < LEG + WORK + LEG) {
          const local = (t - LEG - WORK) / LEG;
          if (pulled) {
            ctx.globalAlpha = 0.95;
            ctx.fillStyle = palette.response;
            const x = s.x1 - s.span * local;
            ctx.fillRect(x - 2, y - 2, 4, 4);
            ctx.globalAlpha = 1;
          } else {
            // The result exists and stays where it was made. A short dissolve at
            // the far post, then nothing: this tooth's return trip never happens.
            const out = Math.max(0, 1 - local / 0.28);
            if (out > 0) {
              ctx.globalAlpha = 0.5 * out;
              ctx.strokeStyle = palette.fade;
              ctx.lineWidth = 1.1;
              ctx.beginPath();
              ctx.arc(s.x1, y, 3 + (1 - out) * 5, 0, Math.PI * 2);
              ctx.stroke();
              ctx.globalAlpha = 1;
            }
          }
        } else if (pulled) {
          // Landed. Only the two awaited values are ever held at the near end.
          ctx.globalAlpha = 0.8;
          ctx.fillStyle = palette.response;
          ctx.fillRect(s.x0 - 2, y - 2, 4, 4);
          ctx.globalAlpha = 1;
        }
      }
    },
  };
}
