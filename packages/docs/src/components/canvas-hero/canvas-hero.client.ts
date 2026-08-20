/**
 * Canvas 2D hero harness.
 *
 * Holds everything the five scenes would otherwise each get wrong:
 *
 * - device pixel ratio capped at 2, matching the WebGL hero, because a 3x phone
 *   would otherwise rasterize nine times the pixels for no visible gain;
 * - the loop is parked when the hero scrolls out of view and when the tab is
 *   hidden, and scene time does not advance while parked, so nothing teleports
 *   when it resumes;
 * - the palette is re-read on a `data-theme` change and the frame is repainted
 *   even while parked, or a scene scrolled past during a toggle keeps the old
 *   colours until it comes back;
 * - `prefers-reduced-motion` gets one composed still frame rather than no canvas
 *   at all, which is what the WebGL hero has to do. A canvas the harness never
 *   animates is not a motion problem, and an empty hero is worse than a static
 *   diagram.
 */
import { readPalette } from "./palette";
import { roundTripField } from "./scenes/round-trip-field";
import type { KeepOut, Palette, Rect, Scene, SceneFactory, SceneSize } from "./types";

/** Elements a scene must not lay a diagram over. */
const CONTENT = ".cw-hero-illus, .cw-hero-scrim, .cw-hero-actions";

/**
 * Of those, the ones that are bare text on the page background.
 *
 * The code windows are excluded on purpose: they are a near-opaque panel, so ink
 * behind them never reaches the eye. The headline, tagline and buttons have
 * nothing behind them, so ink there competes with the words.
 */
const BARE_TEXT = ".cw-hero-scrim, .cw-hero-actions";

/** Over how many pixels an ambient scene fades out as it approaches bare text. */
const FEATHER = 56;

/** Breathing room, so a scene never quite touches the copy. */
const PAD = 16;

/**
 * Measures the hero's content boxes in canvas-local coordinates.
 *
 * One `getBoundingClientRect` pass per resize, not per frame: reading layout in
 * the animation loop would force a synchronous reflow sixty times a second for a
 * number that only changes when the page does.
 */
function measureKeepOut(container: HTMLElement, size: SceneSize): KeepOut {
  const base = container.getBoundingClientRect();
  // Scoped to the hero section, not the document. This is a per-instance mount, so
  // a document-wide query would make two heroes on one page, or a stray
  // `.cw-hero-actions` anywhere else, lay every scene out against the union.
  const root: ParentNode = container.closest("section") ?? document;
  const measure = (selector: string): Rect[] => {
    const out: Rect[] = [];
    for (const el of root.querySelectorAll(selector)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({ x: r.left - base.left, y: r.top - base.top, width: r.width, height: r.height });
    }
    return out;
  };
  return buildKeepOut(measure(CONTENT), measure(BARE_TEXT), size);
}

/**
 * The `KeepOut` behaviour, given boxes that have already been measured.
 *
 * Split out so the initial value can be built without touching the DOM: measuring
 * before the canvas has been sized forces a reflow to produce an object that is
 * discarded, and whose `sideBands` would return negative widths if anything read
 * it in the meantime.
 */
function buildKeepOut(boxes: Rect[], bare: Rect[], size: SceneSize): KeepOut {
  // A hero without copy has nothing to avoid, and every helper still has to
  // return something sane, so degrade to an empty box at the centre.
  const box: Rect = boxes.length
    ? {
        x: Math.min(...boxes.map((b) => b.x)),
        y: Math.min(...boxes.map((b) => b.y)),
        width: 0,
        height: 0,
      }
    : { x: size.width / 2, y: size.height / 2, width: 0, height: 0 };
  if (boxes.length) {
    box.width = Math.max(...boxes.map((b) => b.x + b.width)) - box.x;
    box.height = Math.max(...boxes.map((b) => b.y + b.height)) - box.y;
  }

  const overlapsY = (b: Rect, y: number, height: number) =>
    b.y < y + height + PAD && b.y + b.height + PAD > y;

  const widest = boxes.length ? boxes.reduce((m, b) => (b.width > m.width ? b : m)) : box;

  return {
    boxes,
    bareText: bare,
    box,
    widest,
    bandTop: { x: 0, y: 0, width: size.width, height: Math.max(0, box.y - PAD) },
    sideBands(y, height) {
      const hit = boxes.filter((b) => overlapsY(b, y, height));
      if (hit.length === 0) {
        // Clear all the way across. Split it so a scene that wants two columns
        // still gets two. Clamped like the other branch, so "zero width means no
        // room" holds on both paths rather than handing back a negative.
        const half = Math.max(0, size.width / 2 - PAD);
        return {
          left: { x: 0, y, width: half, height },
          right: { x: size.width / 2 + PAD, y, width: half, height },
        };
      }
      const x0 = Math.min(...hit.map((b) => b.x)) - PAD;
      const x1 = Math.max(...hit.map((b) => b.x + b.width)) + PAD;
      return {
        left: { x: 0, y, width: Math.max(0, x0), height },
        right: { x: x1, y, width: Math.max(0, size.width - x1), height },
      };
    },
    clarity(x, y) {
      let min = 1;
      for (const b of bare) {
        // Euclidean distance from the point to the rect, zero inside it.
        const dx = Math.max(b.x - x, 0, x - (b.x + b.width));
        const dy = Math.max(b.y - y, 0, y - (b.y + b.height));
        const f = Math.min(1, Math.hypot(dx, dy) / FEATHER);
        if (f < min) min = f;
      }
      return min;
    },
    hits(r) {
      return boxes.some(
        (b) =>
          r.x < b.x + b.width + PAD &&
          r.x + r.width + PAD > b.x &&
          r.y < b.y + b.height + PAD &&
          r.y + r.height + PAD > b.y,
      );
    },
  };
}

export function mountCanvasHero(container: HTMLElement, factory: SceneFactory): () => void {
  // One canvas per container, always. Mounting twice appends a second canvas and
  // runs a second animation loop over it, which is how `/9` briefly shipped its
  // comparison figure drawn twice, one copy below the other.
  if (container.dataset.cwCanvasMounted === "1") return () => {};
  container.dataset.cwCanvasMounted = "1";

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) {
    container.removeChild(canvas);
    return () => {};
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const scene: Scene = factory();
  // Built lazily, and only if the primary scene ever reports it cannot fit, so a
  // desktop visitor never pays for a field they will not see.
  let fallback: Scene | null = null;
  let palette: Palette = readPalette();
  let size: SceneSize = { width: 1, height: 1 };
  let keepOut: KeepOut = buildKeepOut([], [], size);
  /** The canvas with the bare-text boxes punched out, for clipping ambient scenes. */
  let bareTextPath: Path2D | null = null;
  /** Set by the disposer, so the one async path it cannot cancel can bail. */
  let disposed = false;

  /** The primary scene, or the ambient field when the primary has no room. */
  const current = (): Scene => {
    if (scene.fits?.() !== false) return scene;
    if (!fallback) {
      fallback = roundTripField();
      fallback.layout?.(size, keepOut);
    }
    return fallback;
  };

  const paint = (t: number, dt: number, still: boolean) => {
    ctx.clearRect(0, 0, size.width, size.height);
    const active = current();
    // Saved unconditionally, so no scene can leak `font`, `textAlign`,
    // `globalAlpha` or a line dash into the next frame or into the other scene.
    // A resize can swap between the primary scene and the fallback, and without
    // this the incoming scene's first frame inherits the outgoing one's state.
    ctx.save();
    if (active.ambient && bareTextPath) {
      // Canvas 2D has no "clip everything but", so the path is the whole canvas
      // with each text rect punched out and the even-odd rule inverting them.
      ctx.clip(bareTextPath, "evenodd");
    }
    active.draw({ ctx, size, keepOut, palette, t, dt, still });
    ctx.restore();
  };

  // ---- sizing ----------------------------------------------------------------

  /**
   * Rects merged until none overlap.
   *
   * The even-odd rule counts crossings, so a point inside two punched rects is
   * back to being inside the clip and would be drawn on. The keep-out boxes do not
   * overlap today, but `BARE_TEXT` is a selector anyone can extend and the failure
   * mode is silent ink in the worst possible place.
   */
  const merged = (rects: Rect[]): Rect[] => {
    const out = rects.map((r) => ({ ...r }));
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        if (a.x >= b.x + b.width || b.x >= a.x + a.width) continue;
        if (a.y >= b.y + b.height || b.y >= a.y + a.height) continue;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        a.width = Math.max(a.x + a.width, b.x + b.width) - x;
        a.height = Math.max(a.y + a.height, b.y + b.height) - y;
        a.x = x;
        a.y = y;
        out.splice(j, 1);
        // The union may now overlap something already passed over.
        i = -1;
        break;
      }
    }
    return out;
  };

  const setSize = () => {
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.floor(w * dpr);
    const chh = Math.floor(h * dpr);
    // `ResizeObserver` fires for sub-pixel changes that floor to the same integer,
    // and continuously through a drag or a rotation. Assigning `canvas.width` resets
    // the backing store, so without this every one of those ticks reallocates the
    // canvas and re-lays out the scene for no change at all.
    if (cw === canvas.width && chh === canvas.height && size.width === w) return;
    canvas.width = cw;
    canvas.height = chh;
    // Scale once here so every scene can think in CSS pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    size = { width: w, height: h };
    keepOut = measureKeepOut(container, size);
    bareTextPath = new Path2D();
    bareTextPath.rect(0, 0, size.width, size.height);
    for (const r of merged(keepOut.bareText)) bareTextPath.rect(r.x, r.y, r.width, r.height);
    scene.layout?.(size, keepOut);
    fallback?.layout?.(size, keepOut);
  };

  const ro = new ResizeObserver(() => {
    setSize();
    paint(sceneTime, 0, reduced.matches);
  });
  ro.observe(container);

  // The keep-out boxes depend on text metrics, so they move when the webfonts swap
  // in, which is always after first paint. The `disposed` guard matters because
  // this is the one async path the disposer cannot cancel: `mount` tears down on
  // `astro:before-swap`, and measuring a detached canvas resizes the scene to 1x1.
  void document.fonts?.ready.then(() => {
    if (disposed) return;
    setSize();
    paint(sceneTime, 0, reduced.matches);
  });

  // ---- clock -----------------------------------------------------------------

  // Scene time is accumulated rather than read off the timestamp, so parking the
  // loop pauses the story instead of fast-forwarding it.
  let sceneTime = 0;
  let last = 0;
  let raf = 0;
  let isVisible = true;
  let isPageVisible = !document.hidden;

  const loop = (now: number) => {
    // First frame after a resume has no meaningful delta; clamp covers both that
    // and a browser that throttled us in a background tab.
    const dt = last === 0 ? 0 : Math.min((now - last) / 1000, 1 / 20);
    last = now;
    sceneTime += dt;
    paint(sceneTime, dt, false);
    raf = requestAnimationFrame(loop);
  };

  const tryStart = () => {
    if (reduced.matches) return;
    if (isVisible && isPageVisible && raf === 0) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
  };
  const tryStop = () => {
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  // ---- scheme ----------------------------------------------------------------

  const schemeObserver = new MutationObserver(() => {
    palette = readPalette();
    // Repaint now: if the loop is parked, nothing else will.
    paint(sceneTime, 0, reduced.matches);
  });
  schemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  // ---- visibility ------------------------------------------------------------

  const io = new IntersectionObserver(
    ([entry]) => {
      isVisible = entry.isIntersecting;
      if (isVisible) tryStart();
      else tryStop();
    },
    { threshold: 0 },
  );
  io.observe(container);

  const onVisibility = () => {
    isPageVisible = !document.hidden;
    if (isPageVisible) tryStart();
    else tryStop();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // Honour a mid-session change to the motion preference in both directions.
  const onReduced = () => {
    if (reduced.matches) {
      tryStop();
      paint(sceneTime, 0, true);
    } else {
      tryStart();
    }
  };
  reduced.addEventListener("change", onReduced);

  // ---- go --------------------------------------------------------------------

  setSize();
  if (reduced.matches) paint(0, 0, true);
  else tryStart();

  return () => {
    disposed = true;
    delete container.dataset.cwCanvasMounted;
    tryStop();
    ro.disconnect();
    io.disconnect();
    schemeObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    reduced.removeEventListener("change", onReduced);
    try {
      container.removeChild(canvas);
    } catch {
      /* already gone */
    }
  };
}
