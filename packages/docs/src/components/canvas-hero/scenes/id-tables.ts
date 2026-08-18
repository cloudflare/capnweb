/**
 * Scene 4: two tables, and the arrow that turns around.
 *
 * Cap'n Web keeps exactly two tables per side, imports and exports, and one
 * side's exports are the other's imports. IDs are allocated by sign and never
 * reused: "the importing side picks the next positive ID (from 1 up), the
 * exporting side picks the next negative ID (from -1 down)", and zero is the
 * main interface (`reference/protocol.md`, Imports and exports).
 *
 * That sign convention is what makes the scene readable. Positive rows grow down
 * the client's side; negative rows grow down the server's; zero sits still in the
 * middle because it is the interface everything starts from.
 *
 * The script is a real captured session: the client passes an `RpcTarget` as an
 * argument, so the message carries `["export",-1]` rather than the object; the
 * server `dup()`s it and, later, calls *back* through that same ID with
 * `["pipeline",-1,["onProgress"],[50]]`. The arrow reverses and the ID is the
 * pivot, because "when describing the meaning of any RPC message, we always take
 * the perspective of the sender". Then `["release", id, refcount]` retires each
 * row, and the next allocation carries on past it: 2 and -2, never 1 and -1
 * again.
 */
import type { KeepOut, Scene, SceneContext, SceneSize } from "../types";
import { fitFont, space } from "./space";

type Dir = "out" | "back";

interface Event {
  t: number;
  /** Wire text, drawn on the message in flight. */
  msg: string;
  dir: Dir;
  /** A row this event opens. */
  opens?: { id: number; label: string };
  /** A row this event retires. */
  closes?: number;
}

const SCRIPT: Event[] = [
  { t: 0.0, msg: '["push",["pipeline",0,["startJob"],["j1",["export",-1]]]]', dir: "out", opens: { id: -1, label: "ProgressSink" } },
  { t: 0.9, msg: '["pull",1]', dir: "out", opens: { id: 1, label: "startJob()" } },
  { t: 1.7, msg: '["resolve",1,"started"]', dir: "back" },
  { t: 2.5, msg: '["release",1,1]', dir: "out", closes: 1 },
  { t: 3.4, msg: '["push",["pipeline",-1,["onProgress"],[50]]]', dir: "back" },
  { t: 4.4, msg: '["push",["pipeline",-1,["onProgress"],[100]]]', dir: "back" },
  { t: 5.4, msg: '["release",-1,1]', dir: "back", closes: -1 },
];

const FLIGHT = 0.72;
const CYCLE = 8.4;
/** How long an arrived message keeps its trail before it starts to go. */
const LINGER = 0.5;
const FADE = 0.4;

interface Row {
  id: number;
  label: string;
  /** 0..1 fade in. */
  in: number;
  /** 0..1 fade to retired. */
  out: number;
}

export function idTables(): Scene {
  let clientX = 0;
  let serverX = 0;
  let top = 0;
  let laneOut = 0;
  let laneBack = 0;
  let midX = 0;
  let fontSize = 10;
  let rowH = 17;
  /**
   * Starts hidden, so a scene whose `layout` has not run yet reports that it does
   * not fit rather than drawing a degenerate diagram at the origin.
   */
  let hide = true;

  /**
   * The two ledgers sit in the two clear columns: positive IDs down the client's
   * side, negative down the server's, which is the sign convention the scene is
   * about, laid out as the geometry.
   *
   * The messages have to cross from one side to the other, and the middle is
   * where the copy lives. So the flight lanes go in the clear strip above the
   * hero content rather than between the ledgers, and there are two of them so an
   * outbound and an inbound message never overlap.
   */
  const layout = (s: SceneSize, k: KeepOut) => {
    const sp = space(s, k);
    const col = Math.min(sp.left.width, sp.right.width);
    fontSize = Math.min(10, fitFont(col, 26, 10));
    rowH = fontSize * 1.7;
    // The deepest ink is the rail, which runs to `top + rowH * 6`, and `top` is
    // itself one row down, so the scene needs seven rows below the column's origin
    // plus a hair for the descender on the last annotation. Getting this wrong
    // clips the bottom line off instead of hiding, and no width sweep finds it
    // because the constraint is on height.
    hide = fontSize < 7.5 || sp.band.height < rowH * 3 || sp.left.height < rowH * 7.1;
    clientX = sp.left.x + sp.left.width / 2;
    serverX = sp.right.x + sp.right.width / 2;
    midX = sp.midX;
    // Two lanes in the strip above, the lower one for traffic coming back.
    laneBack = sp.band.y + sp.band.height - 10;
    laneOut = laneBack - rowH * 1.25;
    top = sp.left.y + rowH;
  };

  /** Rows present at time `t`, with their fades resolved. */
  const rowsAt = (t: number): Row[] => {
    const rows: Row[] = [];
    for (const ev of SCRIPT) {
      // Hoisted so the narrowing survives into the closure below, which is what a
      // non-null assertion would otherwise be papering over.
      const opens = ev.opens;
      if (!opens) continue;
      const born = ev.t + FLIGHT;
      if (t < born) continue;
      const closer = SCRIPT.find((e) => e.closes === opens.id);
      const died = closer ? closer.t + FLIGHT : Infinity;
      rows.push({
        id: opens.id,
        label: opens.label,
        in: Math.min(1, (t - born) / 0.35),
        out: t < died ? 0 : Math.min(1, (t - died) / 0.4),
      });
    }
    return rows;
  };

  const rail = (c: SceneContext, x: number, label: string) => {
    const { ctx, palette } = c;
    ctx.strokeStyle = `rgb(${palette.strokeRgb} / 0.28)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, laneOut);
    ctx.lineTo(x, top + rowH * 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = palette.muted;
    ctx.font = `600 ${fontSize}px ${palette.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.globalAlpha = 0.8;
    ctx.fillText(label, x, laneOut - 6);
    ctx.globalAlpha = 1;
  };

  /** One ledger row. Positive rows sit on the client side, negative on the server's. */
  const drawRow = (c: SceneContext, row: Row, slot: number) => {
    const { ctx, palette } = c;
    const positive = row.id > 0;
    const x = positive ? clientX + 10 : serverX - 10;
    const y = top + slot * rowH;
    const alpha = row.in * (1 - row.out * 0.55);
    const colour = row.out > 0 ? palette.fade : positive ? palette.request : palette.response;

    ctx.textAlign = positive ? "left" : "right";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = alpha;
    ctx.font = `600 ${fontSize}px ${palette.mono}`;
    ctx.fillStyle = colour;
    const idText = String(row.id);
    ctx.fillText(idText, x, y);
    const idW = ctx.measureText(idText).width + 7;
    ctx.font = `400 ${fontSize}px ${palette.mono}`;
    ctx.fillStyle = row.out > 0 ? palette.fade : palette.muted;
    ctx.globalAlpha = alpha * 0.85;
    ctx.fillText(row.label, positive ? x + idW : x - idW, y);

    // A retired row keeps its slot and gets struck through: the ID is gone, and
    // it is never coming back.
    if (row.out > 0) {
      const labelW = ctx.measureText(row.label).width;
      const x0 = positive ? x : x - idW - labelW;
      const x1 = positive ? x + idW + labelW : x;
      ctx.strokeStyle = palette.fade;
      ctx.globalAlpha = row.out * 0.65;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + (x1 - x0) * Math.min(1, row.out * 1.6), y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  return {
    layout,
    fits: () => !hide,
    draw(c) {
      if (hide) return;
      const { ctx, palette } = c;
      // The still is a composition, not a moment: it sits late enough that every
      // ID the session ever allocated is on the ledger, with the release in
      // flight, and it forces the counter on so the "never reused" point lands in
      // the one frame a reduced-motion visitor gets.
      const t = c.still ? 5.4 + FLIGHT * 0.7 : c.t % CYCLE;

      rail(c, clientX, "client");
      rail(c, serverX, "server");

      // ID zero: the main interface, present from the start and belonging to
      // neither side's allocation, so it sits on the server rail where the main
      // interface actually lives rather than floating over the copy.
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.font = `600 ${fontSize}px ${palette.mono}`;
      ctx.fillStyle = palette.stroke;
      ctx.globalAlpha = 0.85;
      ctx.fillText("0", serverX - 10, top);
      ctx.font = `400 ${fontSize}px ${palette.mono}`;
      ctx.fillStyle = palette.muted;
      ctx.globalAlpha = 0.6;
      ctx.fillText("main interface", serverX - 10 - fontSize * 1.4, top);
      ctx.globalAlpha = 1;

      const rows = rowsAt(t);
      const positives = rows.filter((r) => r.id > 0);
      const negatives = rows.filter((r) => r.id < 0);
      positives.forEach((r, i) => drawRow(c, r, 1.2 + i));
      negatives.forEach((r, i) => drawRow(c, r, 1.2 + i));

      // Messages in flight.
      // Messages linger, and the lanes are only 0.9s apart, so two can be on the
      // same lane at once. Only the newest one in each lane gets its text, because
      // two wire messages centred on the same x are unreadable.
      const newest = (dir: "out" | "back") =>
        SCRIPT.filter((e) => e.dir === dir && t - e.t > 0).at(-1);
      const speaking = new Set([newest("out"), newest("back")]);

      for (const ev of SCRIPT) {
        const age = t - ev.t;
        // A message is in flight for FLIGHT, then its trail and its text linger,
        // fading. Without the linger the lane is empty most of the time and the
        // wire text, which is the most informative thing on screen, is a flash you
        // cannot read.
        if (age <= 0 || age >= FLIGHT + LINGER + FADE) continue;
        const f = Math.min(1, age / FLIGHT);
        const decay = 1 - Math.max(0, (age - FLIGHT - LINGER) / FADE);
        const fromX = ev.dir === "out" ? clientX : serverX;
        const toX = ev.dir === "out" ? serverX : clientX;
        const y = ev.dir === "out" ? laneOut : laneBack;
        const x = fromX + (toX - fromX) * f;
        const colour = ev.closes !== undefined ? palette.fade : ev.dir === "out" ? palette.request : palette.response;

        ctx.strokeStyle = colour;
        ctx.globalAlpha = 0.4 * decay;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(fromX, y);
        ctx.lineTo(x, y);
        ctx.stroke();
        // The head only exists while it is moving; once arrived it is just a trail.
        if (f < 1) {
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = colour;
          ctx.fillRect(x - 2, y - 2, 4, 4);
        }

        // The wire text rides above its lane, centred on the page rather than on
        // the moving dot so it never drifts off the edge.
        if (speaking.has(ev)) {
          ctx.font = `400 ${fontSize - 0.5}px ${palette.mono}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.globalAlpha = 0.72 * Math.min(1, age / 0.25) * decay;
          ctx.fillStyle = palette.muted;
          ctx.fillText(ev.msg, midX, y - 6);
        }
        ctx.globalAlpha = 1;
      }

      // The counter that makes "never reused" concrete. It goes in the left
      // gutter under the client's rows, which is where the positive IDs are
      // allocated from.
      if (c.still || t > 6.2) {
        ctx.globalAlpha = (c.still ? 1 : Math.min(1, (t - 6.2) / 0.5)) * 0.7;
        ctx.font = `400 ${fontSize}px ${palette.mono}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = palette.muted;
        ctx.fillText("next: 2 and -2", clientX + 10, top + rowH * 4.4);
        ctx.fillText("never reused", clientX + 10, top + rowH * 5.4);
        ctx.globalAlpha = 1;
      }
    },
  };
}
