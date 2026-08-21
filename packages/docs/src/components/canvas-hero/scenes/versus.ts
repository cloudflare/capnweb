/**
 * Scene 9: the headline claim as a foreground figure, not a backdrop.
 *
 * Every other scene here is art behind the copy. This one is the copy's evidence,
 * so it is mounted in the flow at full contrast with nothing over it, and it is
 * allowed to draw text and to be measured for legibility like any other content.
 *
 * Two sequence diagrams side by side, sharing one vertical time axis. Left is
 * what four dependent calls cost without pipelining: each one is awaited before
 * the next can be written, so each pays for its own round trip, and four round
 * trips on a 100ms link is 400ms. Right is the same four calls with Cap'n Web:
 * every push is written back to back without waiting, because an `RpcPromise` is
 * also a stub for its own eventual result and can be passed as an argument before
 * it resolves. The far end substitutes the real values on arrival and answers
 * once, so the whole chain is one round trip.
 *
 * The shared axis is what makes this an argument rather than two pictures. Both
 * panels are drawn against the same 0..400ms scale, so the right panel visibly
 * stops a quarter of the way down and the 300ms below it is empty. That gap is
 * the product, and it is drawn to scale rather than asserted.
 *
 * Numbers and call names are the docs' own, from `start/pipelining-tour.md`.
 */
import type { Palette, Scene, SceneSize } from "../types";

/** One network leg. A round trip is two, and the docs' link is 100ms. */
const MS_PER_LEG = 50;
/** The slow lane: four round trips, so eight legs, so 400ms. */
const TOTAL_LEGS = 8;
/** Seconds of animation per leg. */
const LEG = 0.62;
const HOLD = 2.4;
const CYCLE = LEG * TOTAL_LEGS + HOLD;
/**
 * Where the reduced-motion still freezes, in legs. The middle of the hold, not
 * its first instant: verdicts fade in over half a leg from the moment they are
 * earned, so freezing at exactly `TOTAL_LEGS` catches the slow lane's verdict at
 * `globalAlpha === 0` and the still loses the very number it exists to show.
 */
const STILL_AT = TOTAL_LEGS + HOLD / LEG / 2;

const CALLS = ["authenticate", "getUserId", "getUserProfile", "getFriendIds"];
/** What the client sends: one pipeline, not four separate awaited calls. */
const BATCH_NOTE = "pipeline";
/**
 * What lands at the far end.
 *
 * Four, not one, and that is not a contradiction of the verdict below it. A
 * pipelined batch is four `push` messages in one body; what there is only one of
 * is the round trip. Saying "one message" at the client was the simplification --
 * this labels the wire honestly at both ends and lets "1 round trip" carry the
 * claim it actually makes.
 */
const ARRIVAL_NOTE = "four messages";
/** Mono advance per character at 1em, the same approximation `space.ts` uses. */
const MONO_ADV = 0.6;
const LABEL_PX = 11;
/** Width of a margin label, plus a little air. */
const needFor = (text: string) => text.length * LABEL_PX * MONO_ADV + 6;
/**
 * The two margins have different jobs and are measured separately.
 *
 * The call names hang off the slow panel's client rail, in the figure's outer
 * margin. The batch note hangs off the fast panel's client rail, in the narrower
 * space between the shared axis and that rail. Sizing both to the longer of the
 * two used to be merely conservative; with the axis in the middle the fast side
 * is genuinely tighter, and one combined threshold would drop both sets of labels
 * on account of a string that is not even in that margin.
 */
const CALL_NEED = Math.max(...CALLS.map(needFor));
const NOTE_NEED = needFor(BATCH_NOTE);
/**
 * The outer margins are equal by construction, so they share one budget.
 *
 * The call names sit in the left one and the arrival note in the right one; the
 * layout mirrors about the axis, so whichever is longer decides whether either
 * can be shown. Taking the max rather than assuming the call names always win
 * keeps that true if the strings change.
 */
const OUTER_NEED = Math.max(CALL_NEED, needFor(ARRIVAL_NOTE));
/** Gap between a margin label and the rail it hangs off. */
const LABEL_GAP = 9;
/**
 * How far the rails sit either side of a panel's centre.
 *
 * 100 rather than the 120 this started at, which is not a taste change: the
 * margin left of the client rail is where the call labels live, and at 11px the
 * longest of them needs ~98px of it. At 120 the labels did not fit inside the
 * hero's 976px figure at any desktop width and were suppressed everywhere. The
 * rails are still 200px apart, which is more than the diagram needs.
 */
const RAIL_HALF = 100;
/**
 * Distance from the shared axis to the nearest rail of each panel.
 *
 * The axis stands between the two diagrams rather than to the left of both, so
 * this is the width of the column it lives in, per side. It has to clear three
 * things: the tick numbers, which hang to the left of the axis line; the slow
 * panel's "server" rail label, which is centred on the rail the numbers approach;
 * and the fast panel's batch note, which hangs into the space on the right.
 *
 * 88 rather than the 104 it needed while that note read "one message": the note
 * is the binding constraint, and shortening it to "pipeline" bought 16px back
 * from the middle of the figure, which is 32px less dead space between the two
 * diagrams. Sized from the measured note, so it moves when the string does.
 */
const AXIS_HALF = 88;
/** The same column when there is no axis in it, so the panels merely separate. */
const BARE_HALF = 24;
/** Clear space between the axis line and anything hanging off the fast rail. */
const AXIS_PAD = 8;
/** Half the width of a centred rail label, the outermost ink when labels are off. */
const RAIL_LABEL_HALF = 22;

interface Panel {
  cx: number;
  clientX: number;
  serverX: number;
}

interface Layout {
  panels: [Panel, Panel];
  /** Top and bottom of the time axis, which both panels share. */
  top: number;
  bottom: number;
  axisX: number;
  showAxis: boolean;
  /** Drop the per-call labels when the panels are too narrow to hold them. */
  compact: boolean;
  /**
   * Whether the saving is named as well as shaded.
   *
   * A separate threshold from `compact`, because they are different lengths in
   * different places: a call label sits in the margin left of the client rail and
   * needs ~110px there, while "300 ms saved" sits centred in a band that is the
   * full width between the rails. Tying both to one flag dropped the figure's
   * punchline at 600px, where it plainly fitted.
   */
  showSaved: boolean;
  headerY: number;
}

export function versus(): Scene {
  let L: Layout | null = null;

  const layout = (s: SceneSize) => {
    const padX = 12;
    const padTop = 10;
    const padBottom = 14;
    // The axis earns its column only when there is width to spare; below that the
    // panels need every pixel and the verdicts still carry the numbers.
    const showAxis = s.width >= 520;
    /*
     * The axis is the middle of the figure, and the two diagrams are placed
     * symmetrically either side of it.
     *
     * It used to hang off the left edge with both panels to the right of it, which
     * is the conventional place for a y-axis and the wrong one here. This axis is
     * not one panel's scale, it is the single shared clock that makes the two
     * readable against each other, and standing it between them says so. It also
     * fixes the composition: the axis was the leftmost ink on the figure with
     * nothing answering it on the right, so the whole thing leaned, and no amount
     * of centring the panels among themselves could correct for an element that
     * only existed on one side.
     *
     * Placing the diagrams by construction rather than by tiling the width is what
     * makes this symmetric for free. There is no panel box any more: each diagram
     * is `inner` from the axis and `half * 2` wide, so the pair is a mirror about
     * the centre at every width, and the margins outside them are equal without
     * being computed.
     */
    const cx = s.width / 2;
    const inner = showAxis ? AXIS_HALF : BARE_HALF;
    // What is left over once the axis column and the outer rail labels are paid
    // for, split between the two diagrams. The cap is the real width; the formula
    // only binds on narrow figures.
    const spare = (s.width - padX * 2 - inner * 2 - RAIL_LABEL_HALF * 2) / 4;
    const half = Math.max(28, Math.min(RAIL_HALF, spare));
    const panels: [Panel, Panel] = [
      { cx: cx - inner - half, clientX: cx - inner - half * 2, serverX: cx - inner },
      { cx: cx + inner + half, clientX: cx + inner, serverX: cx + inner + half * 2 },
    ];
    // Headers, then the rail labels, then the diagram. The verdict lives in the
    // bottom padding under the axis.
    const headerY = padTop;
    const top = padTop + 44;
    const bottom = s.height - padBottom - 26;
    const axisX = cx;
    /*
     * Whether the margin labels fit, measured rather than guessed.
     *
     * A width threshold cannot see what is to the left of each client rail, and
     * that is the only space these labels have. The slow panel's runs out to the
     * edge of the figure; the fast panel's is bounded by the axis line. At 900px a
     * `panelW < 240` test once said there was room while "getUserProfile" was in
     * fact running into the `200` tick, which is why these are subtractions of
     * real coordinates rather than a breakpoint.
     */
    // Equal to the right-hand margin by the mirror, so it stands for both.
    const budget0 = panels[0].clientX - LABEL_GAP - padX;
    const budget1 =
      panels[1].clientX - LABEL_GAP - (showAxis ? axisX + AXIS_PAD : panels[0].serverX + 10);
    L = {
      panels,
      top,
      bottom,
      axisX,
      showAxis,
      compact: budget0 < OUTER_NEED || budget1 < NOTE_NEED,
      showSaved: half * 2 >= 120,
      headerY,
    };
  };

  /** y for a point `legs` into the shared time axis. */
  const yAt = (l: Layout, legs: number) =>
    l.top + (l.bottom - l.top) * Math.min(1, Math.max(0, legs / TOTAL_LEGS));

  const rail = (
    ctx: CanvasRenderingContext2D,
    p: Palette,
    l: Layout,
    x: number,
    label: string,
  ) => {
    ctx.strokeStyle = `rgb(${p.strokeRgb} / 0.35)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, l.top);
    ctx.lineTo(x, l.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = p.muted;
    ctx.globalAlpha = 1;
    ctx.font = `500 ${LABEL_PX}px ${p.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, x, l.top - 7);
  };

  /**
   * One leg of travel, from `fromX` to `toX`, departing at `startLeg`.
   *
   * Draws nothing before it departs and leaves the finished line in place once it
   * has arrived, so the diagram accumulates into a readable trace rather than
   * being a single dot that erases its own history.
   */
  const leg = (
    ctx: CanvasRenderingContext2D,
    p: Palette,
    l: Layout,
    fromX: number,
    toX: number,
    startLeg: number,
    now: number,
    colour: string,
    label?: string,
  ) => {
    if (now < startLeg) return;
    const f = Math.min(1, now - startLeg);
    const y0 = yAt(l, startLeg);
    const y1 = yAt(l, startLeg + 1);
    const x = fromX + (toX - fromX) * f;
    const y = y0 + (y1 - y0) * f;

    ctx.strokeStyle = colour;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(fromX, y0);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colour;
    ctx.fillRect(x - 2.5, y - 2.5, 5, 5);

    if (label && !l.compact) {
      // Outside the rails, not between them. Inside, a label sits directly under
      // the departing line it belongs to and the line crosses its own caption
      // within a few pixels; there is a couple of hundred pixels of clear panel
      // to the left of the client rail, so the label goes there and the diagram
      // reads like the sequence diagram it is.
      ctx.font = `400 ${LABEL_PX}px ${p.mono}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      // Fades in with the leg, but reaches full strength: `muted` is already the
      // measured secondary colour, and multiplying it by a constant is the
      // `opacity` sin that put these labels at 3.48:1 in light.
      ctx.globalAlpha = f;
      ctx.fillStyle = p.muted;
      ctx.fillText(label, fromX - LABEL_GAP, y0);
      ctx.globalAlpha = 1;
    }
  };

  /** The finish line for a panel, plus what it cost. */
  const verdict = (
    ctx: CanvasRenderingContext2D,
    p: Palette,
    l: Layout,
    panel: Panel,
    atLeg: number,
    now: number,
    text: string,
    colour: string,
  ) => {
    if (now < atLeg) return;
    const f = Math.min(1, (now - atLeg) / 0.5);
    const y = yAt(l, atLeg);
    ctx.globalAlpha = f * 0.85;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(panel.clientX - 14, y);
    ctx.lineTo(panel.serverX + 14, y);
    ctx.stroke();
    ctx.globalAlpha = f;
    ctx.fillStyle = colour;
    ctx.font = `600 12px ${p.sans}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(text, panel.cx, y + 7);
    ctx.globalAlpha = 1;
  };

  const drawAxis = (ctx: CanvasRenderingContext2D, p: Palette, l: Layout, now: number) => {
    if (!l.showAxis) return;
    ctx.strokeStyle = `rgb(${p.strokeRgb} / 0.3)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l.axisX, l.top);
    ctx.lineTo(l.axisX, l.bottom);
    ctx.stroke();
    ctx.font = `400 ${LABEL_PX}px ${p.mono}`;
    ctx.textAlign = "right";
    // The unit, once, at the head of the axis, so the ticks can stay bare numbers
    // and the column between the panels stays narrow.
    ctx.textBaseline = "bottom";
    ctx.fillStyle = p.muted;
    ctx.fillText("ms", l.axisX - 6, l.top - 7);
    ctx.textBaseline = "middle";
    // A tick per round trip, which is every two legs, which is every 100ms. The
    // ticks cross the line rather than stopping at it, because the axis now has a
    // diagram on both sides and a tick that only reaches one of them would imply
    // the scale belongs to that one.
    for (let legs = 0; legs <= TOTAL_LEGS; legs += 2) {
      const y = yAt(l, legs);
      ctx.strokeStyle = `rgb(${p.strokeRgb} / 0.35)`;
      ctx.beginPath();
      ctx.moveTo(l.axisX - 3, y);
      ctx.lineTo(l.axisX + 3, y);
      ctx.stroke();
      ctx.fillStyle = p.muted;
      ctx.fillText(`${legs * MS_PER_LEG}`, l.axisX - 6, y);
    }
    // The head of the clock, so the axis reads as elapsed time rather than a ruler.
    const y = yAt(l, Math.min(now, TOTAL_LEGS));
    ctx.strokeStyle = p.muted;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(l.axisX - 4, y);
    ctx.lineTo(l.axisX + 4, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  /**
   * The span the right panel is finished and the left is not.
   *
   * Drawn as a band down the fast panel from its finish line to the slow panel's,
   * because the saving is not a number that belongs in a footnote: it is three
   * quarters of the height of this figure.
   */
  const savings = (ctx: CanvasRenderingContext2D, p: Palette, l: Layout, panel: Panel, now: number) => {
    if (now < 2.05) return;
    const yFrom = yAt(l, 2.05);
    const yTo = yAt(l, Math.min(now, TOTAL_LEGS));
    if (yTo - yFrom < 2) return;
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = p.response;
    ctx.fillRect(panel.clientX, yFrom, panel.serverX - panel.clientX, yTo - yFrom);
    ctx.globalAlpha = 1;
    // Only once the whole saving has played out, so the number never contradicts
    // the band it is labelling.
    if (now >= TOTAL_LEGS && l.showSaved) {
      ctx.fillStyle = p.response;
      ctx.font = `600 12px ${p.sans}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("300 ms saved", panel.cx, (yFrom + yTo) / 2);
      ctx.globalAlpha = 1;
    }
  };

  const header = (
    ctx: CanvasRenderingContext2D,
    p: Palette,
    l: Layout,
    panel: Panel,
    text: string,
    colour: string,
  ) => {
    ctx.fillStyle = colour;
    ctx.font = `600 13px ${p.sans}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(text, panel.cx, l.headerY);
  };

  return {
    // Not ambient: this is a figure in its own box, so there is no copy to avoid
    // and nothing to clip it against.
    layout,
    draw(c) {
      const { ctx, palette: p } = c;
      if (!L) return;
      const l = L;
      // The still is the moment the argument is complete and settled: the fast
      // panel long since finished, the slow one landed, both verdicts fully up.
      const now = c.still ? STILL_AT : (c.t % CYCLE) / LEG;

      const [slow, fast] = l.panels;

      drawAxis(ctx, p, l, now);

      header(ctx, p, l, slow, "Without Cap'n Web", p.muted);
      header(ctx, p, l, fast, "With Cap'n Web", p.foreground);

      // Slow panel: await, reply, await, reply. Four trips, eight legs.
      rail(ctx, p, l, slow.clientX, "client");
      rail(ctx, p, l, slow.serverX, "server");
      for (let i = 0; i < 4; i++) {
        leg(ctx, p, l, slow.clientX, slow.serverX, i * 2, now, p.request, CALLS[i]);
        leg(ctx, p, l, slow.serverX, slow.clientX, i * 2 + 1, now, p.response);
      }
      verdict(ctx, p, l, slow, TOTAL_LEGS, now, "4 round trips \u00b7 400 ms", p.muted);

      // Fast panel: four pushes inside the first leg, then one reply.
      rail(ctx, p, l, fast.clientX, "client");
      rail(ctx, p, l, fast.serverX, "server");
      savings(ctx, p, l, fast, now);
      for (let i = 0; i < 4; i++) {
        // A sixteenth of a leg apart: enough to count, not enough to look like
        // they are waiting on each other.
        const start = i * 0.06;
        if (now < start) continue;
        // Normalised against the distance still to run, so however late a push
        // left it still lands at exactly one leg. The far end cannot answer
        // before its arguments arrive, and the claim is that it answers once.
        const f = Math.min(1, (now - start) / (1 - start));
        const y0 = yAt(l, start);
        const y1 = yAt(l, start + 1);
        const x = fast.clientX + (fast.serverX - fast.clientX) * f;
        const y = y0 + (y1 - y0) * f;
        ctx.strokeStyle = p.request;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(fast.clientX, y0);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = p.request;
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
      }
      if (!l.compact && now > 0.4) {
        ctx.globalAlpha = Math.min(1, (now - 0.4) / 0.5);
        ctx.fillStyle = p.muted;
        ctx.font = `400 ${LABEL_PX}px ${p.mono}`;
        ctx.textBaseline = "middle";
        // What leaves, against the client rail the pushes depart from.
        ctx.textAlign = "right";
        ctx.fillText(BATCH_NOTE, fast.clientX - LABEL_GAP, yAt(l, 0.1));
        ctx.globalAlpha = 1;
      }
      // What arrives, against the server rail, level with the cluster of marks
      // the four pushes land in. Held back until they have actually landed --
      // labelling an arrival before anything has arrived is a lie the eye
      // notices, and the last push lands at `0.18 + 1`.
      if (!l.compact && now > 1.18) {
        ctx.globalAlpha = Math.min(1, (now - 1.18) / 0.5);
        ctx.fillStyle = p.muted;
        ctx.font = `400 ${LABEL_PX}px ${p.mono}`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(ARRIVAL_NOTE, fast.serverX + LABEL_GAP, yAt(l, 1.09));
        ctx.globalAlpha = 1;
      }
      leg(ctx, p, l, fast.serverX, fast.clientX, 1.05, now, p.response);
      verdict(ctx, p, l, fast, 2.05, now, "1 round trip \u00b7 100 ms", p.response);
    },
  };
}
