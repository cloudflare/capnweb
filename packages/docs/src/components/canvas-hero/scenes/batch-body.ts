/**
 * Scene 3: the wire, literally.
 *
 * The HTTP batch transport puts the whole session in one request body, and that
 * body is newline-delimited JSON: "Each message is serialized as a single line of
 * JSON with no embedded newlines, and messages are separated by a newline
 * character" (`reference/protocol.md`, Transport and framing). So the animation
 * is a body being written a line at a time, sent once, and answered once.
 *
 * Every line here is real, captured from the library's own HTTP batch transport
 * running the shape in `transports/http-batch.md`. Three details are the reason
 * this scene exists, and all three are visible:
 *
 *  - `["pipeline",1,["id"]]` is a *property path into a result that does not
 *    exist yet*. Line 2 reads `.id` off line 1's answer before line 1 has been
 *    sent, which is the docs' "Properties pipeline too".
 *  - `["pull", n]` is sent only for what the application actually awaits.
 *  - so `["pull",5]` is absent, and the response therefore has no line 5.
 *    `getUserInfo` was used only as an argument, so its value is never shipped:
 *    "the system detects this and doesn't ask the server to send the return value
 *    back at all; it saves the bandwidth."
 *
 * Six request lines. Five reply lines. One round trip.
 */
import type { KeepOut, Scene, SceneContext, SceneSize } from "../types";
import { fitFont, space } from "./space";

interface Line {
  text: string;
  /** Character range to pick out in ink, for the pipelined argument. */
  mark?: [number, number];
  /** A pull line, drawn quieter than a push. */
  pull?: boolean;
}

/**
 * A line whose pipelined argument is highlighted, located rather than counted.
 *
 * Hand-written offsets into a 68-character JSON literal were wrong by one or two
 * characters on all three marked lines, which is invisible because the highlight
 * lands on identical glyphs either side. Searching for the substring cannot drift
 * when the literal is edited.
 */
const marked = (text: string, arg: string): Line => {
  const i = text.indexOf(arg);
  if (i < 0) throw new Error(`batch-body: ${arg} not found in ${text}`);
  return { text, mark: [i, i + arg.length] };
};

const REQUEST: Line[] = [
  { text: '["push",["pipeline",0,["authenticate"],["cookie-123"]]]' },
  marked('["push",["pipeline",0,["getUserProfile"],[["pipeline",1,["id"]]]]]', '["pipeline",1,["id"]]'),
  marked(
    '["push",["pipeline",0,["getNotifications"],[["pipeline",1,["id"]]]]]',
    '["pipeline",1,["id"]]',
  ),
  { text: '["push",["pipeline",0,["greet"],["Alice"]]]' },
  { text: '["push",["pipeline",0,["getUserInfo"],[]]]' },
  marked('["push",["pipeline",0,["greet"],[["pipeline",5,["name"]]]]]', '["pipeline",5,["name"]]'),
  { text: '["pull",1]', pull: true },
  { text: '["pull",2]', pull: true },
  { text: '["pull",3]', pull: true },
  { text: '["pull",4]', pull: true },
  { text: '["pull",6]', pull: true },
];

const RESPONSE: Line[] = [
  { text: '["resolve",1,["export",-1]]' },
  { text: '["resolve",2,{"name":"u42"}]' },
  { text: '["resolve",3,[["a","b"]]]' },
  { text: '["resolve",4,"Hello, Alice!"]' },
  { text: '["resolve",6,"Hello, Alice!"]' },
];

const WRITE_PER_LINE = 0.2;
const WRITE = REQUEST.length * WRITE_PER_LINE;
const FLIGHT = 0.9;
const REPLY_PER_LINE = 0.16;
const REPLY = RESPONSE.length * REPLY_PER_LINE;
const HOLD = 2.4;
const CYCLE = WRITE + FLIGHT + REPLY + HOLD;

export function batchBody(): Scene {
  let fontSize = 10;
  let lineHeight = 15;
  let reqX = 0;
  let resX = 0;
  let bandX0 = 0;
  let bandX1 = 0;
  let bandY = 0;
  let top = 0;
  /**
   * Starts hidden, so a scene whose `layout` has not run yet reports that it does
   * not fit rather than drawing a degenerate diagram at the origin.
   */
  let hide = true;

  /**
   * The request body goes in the left column and the response in the right, so
   * neither runs under the hero copy, and the one flight between them crosses the
   * clear band above it.
   *
   * Type size is derived from the column width and the longest line rather than
   * chosen: these are 68-character lines of JSON and the whole point is being
   * able to read them. Below the floor the scene hides, because a body of clipped
   * JSON says less than no body at all. That happens under about 1280px, which is
   * honest: there is no width at which this diagram and the copy both fit.
   */
  const layout = (s: SceneSize, k: KeepOut) => {
    const sp = space(s, k);
    const longest = REQUEST.reduce((m, l) => Math.max(m, l.text.length), 0);
    const col = Math.min(sp.left.width, sp.right.width);
    fontSize = fitFont(col, longest);
    lineHeight = fontSize * 1.5;
    // Room for a heading, every request line, and the two-line footnote.
    const needed = lineHeight * (REQUEST.length + 3.5);
    hide = fontSize < 7 || sp.left.height < needed || sp.band.height < lineHeight * 2.5;
    // Right-align the request against the copy and left-align the response, so
    // both bodies sit next to the thing they are talking to.
    reqX = Math.max(2, sp.left.x + sp.left.width - longest * fontSize * 0.6);
    resX = sp.right.x;
    bandX0 = sp.crossX0;
    bandX1 = sp.crossX1;
    bandY = sp.band.y + sp.band.height * 0.62;
    top = sp.left.y + lineHeight * 1.6;
  };

  const heading = (c: SceneContext, x: number, text: string, alpha: number) => {
    const { ctx, palette } = c;
    ctx.font = `600 ${fontSize}px ${palette.mono}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = alpha * 0.8;
    ctx.fillStyle = palette.muted;
    ctx.fillText(text, x, top - lineHeight);
    ctx.globalAlpha = 1;
  };

  /**
   * Draws one line, optionally part-typed, with the marked range in ink and the
   * trailing newline shown as a dim glyph because the framing is the point.
   */
  const drawLine = (
    c: SceneContext,
    line: Line,
    x: number,
    y: number,
    reveal: number,
    baseColour: string,
  ) => {
    const { ctx, palette } = c;
    ctx.font = `400 ${fontSize}px ${palette.mono}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const shown = Math.floor(line.text.length * Math.max(0, Math.min(1, reveal)));
    const text = line.text.slice(0, shown);
    ctx.fillStyle = baseColour;
    ctx.globalAlpha = line.pull ? 0.55 : 0.8;
    ctx.fillText(text, x, y);

    if (line.mark) {
      // Re-draw just the pipelined argument, brighter, in place.
      const [a, b] = line.mark;
      if (shown > a) {
        const prefix = line.text.slice(0, a);
        const seg = line.text.slice(a, Math.min(b, shown));
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette.request;
        ctx.fillText(seg, x + ctx.measureText(prefix).width, y);
      }
    }

    if (shown >= line.text.length) {
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = palette.fade;
      ctx.fillText("\\n", x + ctx.measureText(line.text).width + 3, y);
    }
    ctx.globalAlpha = 1;
  };

  const caret = (c: SceneContext, x: number, y: number, t: number) => {
    const { ctx, palette } = c;
    if (Math.floor(t * 2) % 2 === 0) return;
    ctx.fillStyle = palette.request;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(x, y - fontSize * 0.8, 1.5, fontSize);
    ctx.globalAlpha = 1;
  };

  return {
    layout,
    fits: () => !hide,
    draw(c) {
      if (hide) return;
      const { ctx, palette } = c;
      // The still holds the frame where both bodies are complete, because the
      // missing reply line is the whole point and it only exists at the end.
      const t = c.still ? WRITE + FLIGHT + REPLY : c.t % CYCLE;

      heading(c, reqX, "POST /api  --  request body", 1);

      let y = top;
      for (const [i, line] of REQUEST.entries()) {
        const start = i * WRITE_PER_LINE;
        const reveal = (t - start) / (WRITE_PER_LINE * 0.85);
        if (reveal > 0) drawLine(c, line, reqX, y, reveal, palette.stroke);
        if (reveal > 0 && reveal < 1) {
          ctx.font = `400 ${fontSize}px ${palette.mono}`;
          const shown = Math.floor(line.text.length * reveal);
          caret(c, reqX + ctx.measureText(line.text.slice(0, shown)).width + 1, y, c.t);
        }
        y += lineHeight;
      }

      // One flight, one band. The two bodies are on opposite sides of the copy, so
      // the flight is drawn in the clear strip above it rather than straight
      // through the headline.
      if (t > WRITE) {
        const f = Math.min(1, (t - WRITE) / FLIGHT);
        const x0 = bandX0;
        const x1 = bandX1;
        ctx.strokeStyle = palette.request;
        ctx.globalAlpha = 0.5 * (1 - Math.max(0, (f - 0.7) / 0.3));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x0, bandY);
        ctx.lineTo(x0 + (x1 - x0) * f, bandY);
        ctx.stroke();
        ctx.fillStyle = palette.request;
        ctx.globalAlpha = 0.9 * (1 - Math.max(0, (f - 0.8) / 0.2));
        ctx.fillRect(x0 + (x1 - x0) * f - 2, bandY - 2, 4, 4);
        ctx.globalAlpha = 0.6;
        ctx.font = `500 ${fontSize}px ${palette.mono}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = palette.muted;
        ctx.fillText("6 pushes, 5 replies, 1 round trip", (x0 + x1) / 2, bandY - 6);
        ctx.globalAlpha = 1;
      }

      if (t > WRITE + FLIGHT * 0.75) {
        heading(c, resX, "200 OK  --  response body", 1);
        const rt = t - WRITE - FLIGHT * 0.75;
        let ry = top;
        for (const [i, line] of RESPONSE.entries()) {
          const reveal = (rt - i * REPLY_PER_LINE) / (REPLY_PER_LINE * 0.85);
          if (reveal > 0) drawLine(c, line, resX, ry, reveal, palette.response);
          ry += lineHeight;
        }
        // The gap. Five replies for six pushes, and this says which one and why.
        if (rt > REPLY) {
          const f = Math.min(1, (rt - REPLY) / 0.5);
          ctx.globalAlpha = f * 0.7;
          ctx.fillStyle = palette.fade;
          ctx.font = `400 ${fontSize}px ${palette.mono}`;
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
          ctx.fillText("no line 5:", resX, ry + lineHeight * 0.7);
          ctx.fillText("never awaited, so never pulled", resX, ry + lineHeight * 1.7);
          ctx.globalAlpha = 1;
        }
      }
    },
  };
}
