/**
 * Scene 5: record once, replay N times.
 *
 * `.map()` looks impossible at first glance, because Cap'n Web never ships code.
 * What it ships is a recording. Your callback is invoked exactly once, locally,
 * with a placeholder `RpcPromise` as its argument; the RPCs it makes are not
 * executed but written down as instructions, and the stubs it touches are
 * captured. That becomes one `["remap", importId, path, captures, instructions]`
 * expression, and the peer replays the instruction list once per element
 * (`concepts/map.md`, How the heck does that work?).
 *
 * The three-column shape is the animation: one callback on the left, one message
 * in the middle, three replays on the right. The instruction list is real, from a
 * captured trace of the docs' own example:
 *
 *   let names = await idsPromise.map(id => [id, api.getUserName(id)]);
 *
 * The index convention on the replay side is from `reference/protocol.md#remap`
 * and is drawn literally, because it is what makes the scene legible: negative
 * indices are the captures, zero is the element, positive indices are the results
 * of earlier instructions.
 */
import type { KeepOut, Scene, SceneContext, SceneSize } from "../types";
import { fitFont, space } from "./space";

const INSTRUCTIONS = [
  '0  ["pipeline",-1,["getUserName"],[["pipeline",0]]]',
  '1  [[["pipeline",0],["pipeline",1]]]',
];

/**
 * The callback source, in one place.
 *
 * The recording bar's width is measured from this string, so a second copy meant
 * the bar could sweep the wrong distance the moment one of them was edited.
 */
const CALLBACK = "id => [id, api.getUserName(id)]";

/** Paired, so the element and its result cannot fall out of step by index. */
const REPLAYS = [
  { element: "1", result: '[1,"n1"]' },
  { element: "2", result: '[2,"n2"]' },
  { element: "3", result: '[3,"n3"]' },
];

const RECORD_AT = 0.5;
const RECORD_FOR = 1.1;
const SEND_AT = 2.0;
const SEND_FOR = 0.85;
const REPLAY_AT = 3.0;
const REPLAY_STEP = 0.42;
const RESOLVE_AT = 4.7;
const CYCLE = 8.0;

export function mapReplay(): Scene {
  let leftX = 0;
  let midX = 0;
  let rightX = 0;
  let top = 0;
  let laneY = 0;
  let bandX0 = 0;
  let bandX1 = 0;
  let fontSize = 10;
  let rowH = 16;
  let compact = false;
  /**
   * Starts hidden, so a scene whose `layout` has not run yet reports that it does
   * not fit rather than drawing a degenerate diagram at the origin.
   */
  let hide = true;

  /**
   * Recording on the left, replays on the right, and the one message that carries
   * the recording between them travelling through the clear strip above the copy.
   *
   * Type size comes from the column width and the longest string the scene draws,
   * for the same reason as the batch body: an instruction list is only interesting
   * if you can read the indices.
   */
  const layout = (s: SceneSize, k: KeepOut) => {
    const sp = space(s, k);
    const col = Math.min(sp.left.width, sp.right.width);
    const longest = INSTRUCTIONS.reduce((m, l) => Math.max(m, l.length), 0);
    fontSize = fitFont(col, longest, 10);
    rowH = fontSize * 1.6;
    hide = fontSize < 7 || sp.band.height < rowH * 3 || sp.left.height < rowH * 7;
    compact = col < 300;
    leftX = sp.left.x + 6;
    rightX = sp.right.x + 6;
    midX = sp.midX;
    bandX0 = sp.crossX0;
    bandX1 = sp.crossX1;
    laneY = sp.band.y + sp.band.height - 10;
    top = sp.left.y + rowH * 1.6;
  };

  const label = (c: SceneContext, text: string, x: number, y: number, alpha: number, align: CanvasTextAlign = "left") => {
    const { ctx, palette } = c;
    ctx.font = `600 ${fontSize}px ${palette.mono}`;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = alpha * 0.8;
    ctx.fillStyle = palette.muted;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  };

  const mono = (
    c: SceneContext,
    text: string,
    x: number,
    y: number,
    alpha: number,
    colour: string,
    weight = 400,
  ) => {
    const { ctx, palette } = c;
    ctx.font = `${weight} ${fontSize}px ${palette.mono}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  };

  return {
    layout,
    fits: () => !hide,
    draw(c) {
      if (hide) return;
      const { ctx, palette } = c;
      // The still shows all three replays done and the single answer forming.
      const t = c.still ? RESOLVE_AT + 0.5 : c.t % CYCLE;

      // ---- left: the callback, run once -------------------------------------
      label(c, "your callback \u00b7 runs once, locally", leftX, top - rowH, 1);
      const recF = Math.max(0, Math.min(1, (t - RECORD_AT) / RECORD_FOR));
      mono(c, CALLBACK, leftX, top + rowH * 0.4, 0.85, palette.stroke);
      if (t > RECORD_AT) {
        // A recording bar sweeping the callback once.
        ctx.strokeStyle = palette.request;
        ctx.globalAlpha = 0.5 * (1 - Math.max(0, (recF - 0.75) / 0.25));
        ctx.lineWidth = 1.5;
        // Set explicitly rather than relying on whatever `mono` left behind.
        ctx.font = `400 ${fontSize}px ${palette.mono}`;
        const w = ctx.measureText(CALLBACK).width;
        const bx = leftX + w * recF;
        ctx.beginPath();
        ctx.moveTo(bx, top + rowH * 0.4 - fontSize);
        ctx.lineTo(bx, top + rowH * 0.4 + 4);
        ctx.stroke();
        ctx.globalAlpha = 1;
        mono(c, "recording", leftX, top + rowH * 1.7, Math.min(1, recF * 2) * 0.6, palette.request);
      }

      // ---- the instructions it produced -------------------------------------
      if (recF > 0.4) {
        const a = Math.min(1, (recF - 0.4) / 0.4);
        label(c, "captures  [[\"import\",0]]", leftX, top + rowH * 3.1, a);
        INSTRUCTIONS.forEach((line, i) => {
          mono(c, line, leftX, top + rowH * (4.1 + i), a * 0.85, palette.stroke);
        });
      }

      // ---- middle: one message ----------------------------------------------
      if (t > SEND_AT) {
        const f = Math.min(1, (t - SEND_AT) / SEND_FOR);
        const y = laneY;
        const x0 = bandX0;
        const x1 = bandX1;
        ctx.strokeStyle = palette.request;
        ctx.globalAlpha = 0.45 * (1 - Math.max(0, (f - 0.75) / 0.25));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + (x1 - x0) * f, y);
        ctx.stroke();
        ctx.fillStyle = palette.request;
        ctx.globalAlpha = 0.9 * (1 - Math.max(0, (f - 0.85) / 0.15));
        ctx.fillRect(x0 + (x1 - x0) * f - 2, y - 2, 4, 4);
        ctx.globalAlpha = 0.68 * Math.sin(Math.min(1, f) * Math.PI);
        ctx.font = `400 ${fontSize - 0.5}px ${palette.mono}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = palette.muted;
        ctx.fillText(compact ? '["remap",6,...]' : '["remap",6,[],captures,instructions]', midX, y - 7);
        ctx.globalAlpha = 1;
      }

      // ---- right: replayed once per element ---------------------------------
      if (t > REPLAY_AT - 0.3) {
        label(c, "peer \u00b7 replays per element", rightX, top - rowH, 1);
        // The index convention, which is the key to reading the instructions.
        if (!compact) {
          mono(c, "-1 capture   0 element   1+ earlier", rightX, top + rowH * 0.4, 0.55, palette.muted);
        }
        REPLAYS.forEach(({ element, result }, i) => {
          const start = REPLAY_AT + i * REPLAY_STEP;
          const f = Math.max(0, Math.min(1, (t - start) / REPLAY_STEP));
          if (f <= 0) return;
          const y = top + rowH * (2.1 + i * 1.5);
          mono(c, `0 = ${element}`, rightX, y, f * 0.8, palette.stroke);
          // Instruction 0 runs, then instruction 1 builds the pair.
          if (f > 0.35) {
            mono(c, "\u2192 getUserName", rightX + fontSize * 5.2, y, Math.min(1, (f - 0.35) / 0.3) * 0.7, palette.request);
          }
          if (f >= 1) {
            mono(c, result, rightX + fontSize * 13.5, y, 0.9, palette.response, 600);
          }
        });
      }

      // ---- one answer -------------------------------------------------------
      // In the band, above the message lane: the middle of the page belongs to
      // the headline.
      if (t > RESOLVE_AT) {
        const f = Math.min(1, (t - RESOLVE_AT) / 0.6);
        ctx.globalAlpha = f * 0.8;
        ctx.font = `500 ${fontSize}px ${palette.mono}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = palette.response;
        ctx.fillText("1 recording \u00b7 3 replays \u00b7 1 round trip", midX, laneY - rowH * 1.3);
        ctx.globalAlpha = 1;
      }
    },
  };
}
