/**
 * Scene 9: the headline claim as a foreground figure, not a backdrop.
 *
 * Every other scene here is art behind the copy. This one is the copy's evidence,
 * so it is mounted in the flow at full contrast with nothing over it, and it is
 * allowed to draw text and to be measured for legibility like any other content.
 *
 * Two sequence diagrams side by side, sharing one vertical time axis. Left is
 * what four dependent calls cost without pipelining: each one is awaited before
 * the next can be written, so each pays for its own round trip and its own turn
 * at the far end, which on a 100ms link with a 10ms handler is 440ms. Right is
 * the same four calls with Cap'n Web: every push is written back to back without
 * waiting, because an `RpcPromise` is also a stub for its own eventual result and
 * can be passed as an argument before it resolves. The far end substitutes the
 * real values on arrival, runs all four handlers, and answers once: 140ms.
 *
 * The 40ms of server work is identical on both sides, and that is deliberate.
 * The saving is not the far end doing less, it is the four trips it no longer
 * spends waiting between doing it.
 *
 * The shared axis is what makes this an argument rather than two pictures. Both
 * panels are drawn against the same 0..440ms scale, so the right panel visibly
 * stops a third of the way down and the 300ms below it is empty. That gap is the
 * product, and it is drawn to scale rather than asserted.
 *
 * Numbers and call names are the docs' own, from `start/pipelining-tour.md`.
 */
import type { Palette, Scene, SceneSize } from "../types";

/*
 * The figure's clock is milliseconds of story, not frames and not "legs".
 *
 * It was in legs, where one leg was one network crossing and everything else was
 * expressed as a fraction of one. That was fine while the far end answered
 * instantly, and stopped being fine the moment the server got a running time of
 * its own: 10ms is a fifth of a leg, and a model that can only count crossings
 * cannot place it. Everything below is in milliseconds and `yAt` is the only
 * thing that knows how tall a millisecond is.
 */

/** One network crossing. A round trip is two, and the docs' link is 100ms. */
const MS_PER_LEG = 50;
/**
 * What the far end spends on one call before it can answer.
 *
 * Small, but not zero, and drawing it as zero was a quiet lie: it made the server
 * an ideal mirror and put the entire cost of the chain on the network. It also
 * flattered the pipelined side, where four handlers run back to back and the
 * saving comes from the trips they no longer each wait for -- not from the work
 * disappearing. The work is the same 40ms on both sides. That is the point.
 */
const MS_SERVER = 10;
const CALL_COUNT = 4;
/** Await each: out, work, back, four times over. */
const SLOW_MS = CALL_COUNT * (MS_PER_LEG * 2 + MS_SERVER);
/** Pipelined: out once, all four handlers, back once. */
const FAST_MS = MS_PER_LEG * 2 + CALL_COUNT * MS_SERVER;
/** The axis is as tall as the slower of the two. */
const TOTAL_MS = SLOW_MS;
const SAVED_MS = SLOW_MS - FAST_MS;

/** Seconds of animation per millisecond of story. */
const SEC_PER_MS = 0.62 / MS_PER_LEG;
const HOLD = 2.4;
const CYCLE = TOTAL_MS * SEC_PER_MS + HOLD;
/** How long a verdict or a label takes to fade up, in story milliseconds. */
const FADE_MS = 25;
/**
 * Where the reduced-motion still freezes. The middle of the hold, not its first
 * instant: verdicts fade in from the moment they are earned, so freezing at
 * exactly `TOTAL_MS` catches the slow lane's verdict at `globalAlpha === 0` and
 * the still loses the very number it exists to show.
 */
const STILL_AT = TOTAL_MS + HOLD / SEC_PER_MS / 2;

const CALLS = ["authenticate", "getUserId", "getUserProfile", "getFriendIds"];
/**
 * What lands at the far end: one request carrying all four calls.
 *
 * Named at the server rail as well as the client one because the two ends are
 * making different halves of the same point. The client wrote a pipeline; what
 * crossed the wire was a single batched request; and the far end therefore runs
 * all four handlers before it answers at all.
 */
const ARRIVAL_NOTE = "batched request";
/** Mono advance per character at 1em, the same approximation `space.ts` uses. */
const MONO_ADV = 0.6;
const LABEL_PX = 11;
/** Width of a margin label, plus a little air. */
const needFor = (text: string) => text.length * LABEL_PX * MONO_ADV + 6;
const CALL_NEED = Math.max(...CALLS.map(needFor));
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
/** Clear space between the axis column and the nearest ink either side of it. */
const AXIS_PAD = 8;
/** Half the width of a centred rail label, the outermost ink when labels are off. */
const RAIL_LABEL_HALF = 22;
/** The widest thing hanging left of the axis line: a tick number, plus its gap. */
const TICK_NEED = 6 + Math.ceil(String(TOTAL_MS - (TOTAL_MS % 100)).length * LABEL_PX * MONO_ADV);
/**
 * Distance from the shared axis to the nearest rail of each panel.
 *
 * The axis stands between the two diagrams rather than to the left of both, so
 * this is the width of the column it lives in, per side, and the two sides do not
 * need the same thing. Computed rather than typed, because every previous value
 * here was a number someone had measured once and then left behind: it was 104
 * while the fast panel's client rail carried a "one message" note, then 88 when
 * that note was shortened to "pipeline".
 *
 * The note is now gone entirely, so the right side has nothing in it but the fast
 * panel's "client" rail label and the left side is the binding one: the slow
 * panel's "server" label, then the tick numbers reaching back towards it. That is
 * 56, which takes another 64px of dead space out of the middle of the figure.
 */
const AXIS_HALF =
  Math.max(
    // Left: the "server" rail label, then the tick numbers approaching it.
    RAIL_LABEL_HALF + TICK_NEED,
    // Right: the "client" rail label, and nothing else any more.
    RAIL_LABEL_HALF,
  ) + AXIS_PAD;
/** The same column when there is no axis in it, so the panels merely separate. */
const BARE_HALF = 24;

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
     * Both remaining labels -- the call names off the slow panel's client rail and
     * the arrival note off the fast panel's server rail -- now live in the figure's
     * outer margins, which are equal by the mirror, so one budget stands for both.
     * There used to be a second budget for the space between the axis and the fast
     * client rail; nothing hangs there any more.
     *
     * A width threshold cannot see what is beside a rail. At 900px a `panelW < 240`
     * test once said there was room while "getUserProfile" was in fact running into
     * the `200` tick, which is why this is a subtraction of real coordinates rather
     * than a breakpoint.
     */
    const budget = panels[0].clientX - LABEL_GAP - padX;
    L = {
      panels,
      top,
      bottom,
      axisX,
      showAxis,
      compact: budget < OUTER_NEED,
      showSaved: half * 2 >= 120,
      headerY,
    };
  };

  /** y for a point `ms` into the shared time axis. */
  const yAt = (l: Layout, ms: number) =>
    l.top + (l.bottom - l.top) * Math.min(1, Math.max(0, ms / TOTAL_MS));

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
   * One crossing, from `fromX` to `toX`, departing at `startMs`.
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
    startMs: number,
    now: number,
    colour: string,
    label?: string,
  ) => {
    if (now < startMs) return;
    const f = Math.min(1, (now - startMs) / MS_PER_LEG);
    const y0 = yAt(l, startMs);
    const y1 = yAt(l, startMs + MS_PER_LEG);
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
    atMs: number,
    now: number,
    text: string,
    colour: string,
  ) => {
    if (now < atMs) return;
    const f = Math.min(1, (now - atMs) / FADE_MS);
    const y = yAt(l, atMs);
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
    // A round tick every 100ms. The axis runs past the last one, to 440, because
    // the scale is the slow lane's real cost and rounding it down to fit the
    // labels would be drawing a different number from the one in the verdict. The
    // ticks cross the line rather than stopping at it, because the axis has a
    // diagram on both sides and a tick reaching only one would imply the scale
    // belonged to that one.
    for (let ms = 0; ms <= TOTAL_MS; ms += 100) {
      const y = yAt(l, ms);
      ctx.strokeStyle = `rgb(${p.strokeRgb} / 0.35)`;
      ctx.beginPath();
      ctx.moveTo(l.axisX - 3, y);
      ctx.lineTo(l.axisX + 3, y);
      ctx.stroke();
      ctx.fillStyle = p.muted;
      ctx.fillText(`${ms}`, l.axisX - 6, y);
    }
    // The head of the clock, so the axis reads as elapsed time rather than a ruler.
    const y = yAt(l, Math.min(now, TOTAL_MS));
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
    if (now < FAST_MS) return;
    const yFrom = yAt(l, FAST_MS);
    const yTo = yAt(l, Math.min(now, TOTAL_MS));
    if (yTo - yFrom < 2) return;
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = p.response;
    ctx.fillRect(panel.clientX, yFrom, panel.serverX - panel.clientX, yTo - yFrom);
    ctx.globalAlpha = 1;
    // Only once the whole saving has played out, so the number never contradicts
    // the band it is labelling.
    if (now >= TOTAL_MS && l.showSaved) {
      ctx.fillStyle = p.response;
      ctx.font = `600 12px ${p.sans}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${SAVED_MS} ms saved`, panel.cx, (yFrom + yTo) / 2);
      ctx.globalAlpha = 1;
    }
  };

  /**
   * The far end working, drawn on the server rail from arrival to answer.
   *
   * Ten milliseconds is seven pixels of a 306px axis, and seven pixels of nothing
   * between an incoming line and an outgoing one reads as a rendering fault
   * rather than as time passing. A solid cap on the rail says the gap is the
   * point. It is a graphical object, so it answers to 3:1 rather than 4.5:1.
   */
  const work = (
    ctx: CanvasRenderingContext2D,
    p: Palette,
    l: Layout,
    x: number,
    fromMs: number,
    toMs: number,
    now: number,
  ) => {
    if (now <= fromMs) return;
    const y0 = yAt(l, fromMs);
    const y1 = yAt(l, Math.min(now, toMs));
    ctx.strokeStyle = p.muted;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 3;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, Math.max(y1, y0 + 1));
    ctx.stroke();
    ctx.globalAlpha = 1;
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
      const now = c.still ? STILL_AT : (c.t % CYCLE) / SEC_PER_MS;

      const [slow, fast] = l.panels;

      drawAxis(ctx, p, l, now);

      header(ctx, p, l, slow, "Without Cap'n Web", p.muted);
      header(ctx, p, l, fast, "With Cap'n Web", p.foreground);

      // Slow panel: out, work, back, four times over.
      rail(ctx, p, l, slow.clientX, "client");
      rail(ctx, p, l, slow.serverX, "server");
      for (let i = 0; i < CALL_COUNT; i++) {
        // Nothing about call i+1 can be written until call i has come back, which
        // is the whole reason this column is as tall as it is.
        const sent = i * (MS_PER_LEG * 2 + MS_SERVER);
        const landed = sent + MS_PER_LEG;
        leg(ctx, p, l, slow.clientX, slow.serverX, sent, now, p.request, CALLS[i]);
        work(ctx, p, l, slow.serverX, landed, landed + MS_SERVER, now);
        leg(ctx, p, l, slow.serverX, slow.clientX, landed + MS_SERVER, now, p.response);
      }
      verdict(ctx, p, l, slow, SLOW_MS, now, `4 round trips \u00b7 ${SLOW_MS} ms`, p.muted);

      // Fast panel: four pushes inside one crossing, four handlers back to back,
      // then a single reply.
      rail(ctx, p, l, fast.clientX, "client");
      rail(ctx, p, l, fast.serverX, "server");
      savings(ctx, p, l, fast, now);
      for (let i = 0; i < CALL_COUNT; i++) {
        // Three milliseconds apart: enough to count, not enough to look like they
        // are waiting on each other.
        const start = i * 3;
        if (now < start) continue;
        // Normalised against the distance still to run, so however late a push
        // left it still lands at exactly one crossing. The far end cannot start
        // before its arguments arrive, and the claim is that it answers once.
        const f = Math.min(1, (now - start) / (MS_PER_LEG - start));
        const y0 = yAt(l, start);
        const y1 = yAt(l, start + MS_PER_LEG);
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
      // All four handlers run back to back before anything goes back, which is
      // the same 40ms of work the other column spends in four separate visits.
      work(ctx, p, l, fast.serverX, MS_PER_LEG, MS_PER_LEG + CALL_COUNT * MS_SERVER, now);
      // What arrived, against the server rail, level with the marks the pushes
      // land in. Held back until they have actually landed: labelling an arrival
      // before anything has arrived is a lie the eye notices.
      if (!l.compact && now > MS_PER_LEG) {
        ctx.globalAlpha = Math.min(1, (now - MS_PER_LEG) / FADE_MS);
        ctx.fillStyle = p.muted;
        ctx.font = `400 ${LABEL_PX}px ${p.mono}`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(ARRIVAL_NOTE, fast.serverX + LABEL_GAP, yAt(l, MS_PER_LEG));
        ctx.globalAlpha = 1;
      }
      leg(ctx, p, l, fast.serverX, fast.clientX, FAST_MS - MS_PER_LEG, now, p.response);
      verdict(ctx, p, l, fast, FAST_MS, now, `1 round trip \u00b7 ${FAST_MS} ms`, p.response);
    },
  };
}
