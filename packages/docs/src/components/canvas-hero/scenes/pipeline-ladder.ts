/**
 * Scene 2: the headline claim, drawn as two sequence diagrams racing.
 *
 * Left lane is the ordinary way: four dependent calls, each awaited before the
 * next can be written, so each one pays for its own round trip. Right lane is
 * the same four calls pipelined: every push is written back to back without
 * waiting, because an `RpcPromise` is also a stub for its own eventual result
 * and can be passed as an argument before it resolves. The server substitutes
 * the real values on arrival and answers once.
 *
 * The two lanes start together and are drawn on one shared time axis, which is
 * the only honest way to show the difference: the right lane is finished and
 * idle while the left lane is still on its second trip. The numbers on the
 * labels are the docs' own, from `start/pipelining-tour.md`: "Four dependent
 * calls means four round trips... On a 100 ms link, that's 400 ms of doing
 * nothing", against "arbitrary depth of dependency, one round trip".
 *
 * The message text is real, taken from a captured trace of the tour's example:
 * a push carries `["pipeline", importId, path, args]`, and a dependent call
 * references an import ID that does not exist yet.
 */
import type { KeepOut, Scene, SceneContext, SceneSize } from "../types";
import { space } from "./space";

/** Seconds of animation that stand for one 100 ms network leg. */
const LEG = 0.85;
/** Four trips on the left, so the cycle is four legs out and back, plus a hold. */
const CYCLE = LEG * 8 + 2.2;

interface Lane {
  /** Centre x of the lane. */
  cx: number;
  clientX: number;
  serverX: number;
}

const CALLS = [
  "authenticate",
  "getUserId",
  "getUserProfile",
  "getFriendIds",
];

export function pipelineLadder(): Scene {
  let left: Lane = { cx: 0, clientX: 0, serverX: 0 };
  let right: Lane = { cx: 0, clientX: 0, serverX: 0 };
  let top = 0;
  let bottom = 0;
  let compact = false;
  /**
   * Starts hidden, so a scene whose `layout` has not run yet reports that it does
   * not fit rather than drawing a degenerate diagram at the origin.
   */
  let hide = true;

  /**
   * One lane per clear column, so the two diagrams frame the copy instead of
   * running under it. A lane needs room for two rails plus their labels; below
   * that the scene is better off absent than clipped.
   */
  const layout = (s: SceneSize, k: KeepOut) => {
    const sp = space(s, k);
    const w = Math.min(sp.left.width, sp.right.width);
    hide = w < 150 || sp.left.height < 150;
    compact = w < 300;
    const half = Math.min(130, w * 0.34);
    const leftCx = sp.left.x + sp.left.width / 2;
    const rightCx = sp.right.x + sp.right.width / 2;
    left = { cx: leftCx, clientX: leftCx - half, serverX: leftCx + half };
    right = { cx: rightCx, clientX: rightCx - half, serverX: rightCx + half };
    // Rails run the height of the column. Above them sit two stacked labels: the
    // lane's name, then `client` and `server` on the rails themselves.
    top = sp.left.y + 42;
    bottom = sp.left.y + sp.left.height - 28;
  };

  /** y for a point `legs` legs into the shared time axis. */
  const yAt = (legs: number) => top + (bottom - top) * Math.min(1, legs / 8);

  const rail = (c: SceneContext, x: number, label: string, align: CanvasTextAlign) => {
    const { ctx, palette } = c;
    ctx.strokeStyle = `rgb(${palette.strokeRgb} / 0.3)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = palette.muted;
    ctx.font = `500 10px ${palette.mono}`;
    ctx.textAlign = align;
    ctx.textBaseline = "bottom";
    ctx.globalAlpha = 0.75;
    ctx.fillText(label, x, top - 6);
    ctx.globalAlpha = 1;
  };

  /**
   * One leg of travel. `from`/`to` are x positions, `startLeg` is when it left,
   * and `now` is the current position on the shared axis. Draws nothing until it
   * has departed, and leaves a static line once it has arrived.
   */
  const leg = (
    c: SceneContext,
    fromX: number,
    toX: number,
    startLeg: number,
    now: number,
    colour: string,
    label?: string,
  ) => {
    const { ctx, palette } = c;
    if (now < startLeg) return;
    const f = Math.min(1, now - startLeg);
    const y0 = yAt(startLeg);
    const y1 = yAt(startLeg + 1);
    const x = fromX + (toX - fromX) * f;
    const y = y0 + (y1 - y0) * f;

    ctx.strokeStyle = colour;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(fromX, y0);
    ctx.lineTo(x, y);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = colour;
    ctx.fillRect(x - 2, y - 2, 4, 4);

    // Labels hug the departure rail rather than the moving head: a label that
    // travels with the dot ends up outside the lane and over the copy. They hang
    // *below* the departure point, because above it on the first leg is where the
    // `client` rail label already is.
    if (label && !compact) {
      ctx.font = `400 9.5px ${palette.mono}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = 0.55 * f;
      ctx.fillStyle = palette.muted;
      ctx.fillText(label, fromX + 5, y0 + 4);
      ctx.globalAlpha = 1;
    }
  };

  const verdict = (c: SceneContext, lane: Lane, atLeg: number, now: number, text: string, colour: string) => {
    const { ctx, palette } = c;
    if (now < atLeg) return;
    const f = Math.min(1, (now - atLeg) / 0.6);
    const y = yAt(atLeg) + 20;
    ctx.globalAlpha = f * 0.95;
    ctx.fillStyle = colour;
    ctx.font = `600 ${compact ? 10 : 11}px ${palette.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(text, lane.cx, y);
    ctx.globalAlpha = f * 0.5;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lane.cx - 34, y - 7);
    ctx.lineTo(lane.cx + 34, y - 7);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  /** Left lane: await, reply, await, reply. Four trips, eight legs. */
  const drawSequential = (c: SceneContext, now: number) => {
    const { palette } = c;
    rail(c, left.clientX, "client", "center");
    rail(c, left.serverX, "server", "center");
    for (let i = 0; i < 4; i++) {
      leg(c, left.clientX, left.serverX, i * 2, now, palette.request, CALLS[i]);
      leg(c, left.serverX, left.clientX, i * 2 + 1, now, palette.response);
    }
    verdict(c, left, 8, now, "4 round trips \u00b7 400 ms", palette.fade);
  };

  /**
   * Right lane: four pushes leave inside the first leg, staggered only enough to
   * be countable, then one resolve comes back. The chain never waits.
   */
  const drawPipelined = (c: SceneContext, now: number) => {
    const { ctx, palette } = c;
    rail(c, right.clientX, "client", "center");
    rail(c, right.serverX, "server", "center");

    for (let i = 0; i < 4; i++) {
      // All four depart inside the first leg, a sixteenth of one apart: enough to
      // be countable, not enough to look like they are waiting on each other.
      const start = i * 0.06;
      if (now < start) continue;
      // Normalised against the distance still to run, so however late a push left,
      // it lands at exactly one leg. The server cannot answer before its arguments
      // arrive, and this scene's whole claim is that it answers once, after them.
      const f = Math.min(1, (now - start) / (1 - start));
      const y0 = yAt(start);
      const y1 = yAt(start + 1);
      const x = right.clientX + (right.serverX - right.clientX) * f;
      const y = y0 + (y1 - y0) * f;
      ctx.strokeStyle = palette.request;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(right.clientX, y0);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = palette.request;
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }

    // The dependent argument, spelled the way the wire spells it. Shortened
    // rather than dropped when the gutter is tight: the point is that an
    // argument can *be* a reference to a result that does not exist yet.
    if (now > 0.35) {
      ctx.globalAlpha = Math.min(1, (now - 0.35) / 0.5) * 0.62;
      ctx.fillStyle = palette.muted;
      ctx.font = `400 9.5px ${palette.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(compact ? '["pipeline",2]' : '["pipeline",2,["getUserProfile"]]', right.cx, yAt(1.05));
      ctx.globalAlpha = 1;
    }

    leg(c, right.serverX, right.clientX, 1.05, now, palette.response);
    verdict(c, right, 2.05, now, "1 round trip \u00b7 100 ms", palette.response);
  };

  const drawLabel = (c: SceneContext) => {
    const { ctx, palette } = c;
    ctx.font = `500 10px ${palette.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = palette.muted;
    ctx.textBaseline = "bottom";
    ctx.fillText("await each", left.cx, top - 21);
    ctx.fillText("pipelined", right.cx, top - 21);
    ctx.globalAlpha = 1;
  };

  return {
    layout,
    fits: () => !hide,
    draw(c) {
      if (hide) return;
      // The still shows the moment the right lane has answered and the left is
      // only halfway: the comparison, in one frame.
      const now = c.still ? 4.2 : (c.t % CYCLE) / LEG;
      drawLabel(c);
      drawSequential(c, now);
      drawPipelined(c, now);
    },
  };
}
