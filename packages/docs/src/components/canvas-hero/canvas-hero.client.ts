/**
 * Canvas 2D scene harness.
 *
 * Holds everything a scene would otherwise have to get right for itself:
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
import type { Palette, Scene, SceneFactory, SceneSize } from "./types";

export function mountCanvasHero(container: HTMLElement, factory: SceneFactory): () => void {
  // One canvas per container, always. Mounting twice appends a second canvas and
  // runs a second animation loop over it, which is how the hero figure briefly
  // shipped drawn twice, one copy below the other.
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
  let palette: Palette = readPalette();
  let size: SceneSize = { width: 1, height: 1 };
  /** Set by the disposer, so the one async path it cannot cancel can bail. */
  let disposed = false;

  const paint = (t: number, dt: number, still: boolean) => {
    ctx.clearRect(0, 0, size.width, size.height);
    // Saved unconditionally, so a scene cannot leak `font`, `textAlign`,
    // `globalAlpha` or a line dash out of one frame and into the next.
    ctx.save();
    scene.draw({ ctx, size, palette, t, dt, still });
    ctx.restore();
  };

  // ---- sizing ----------------------------------------------------------------

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
    scene.layout?.(size);
  };

  const ro = new ResizeObserver(() => {
    setSize();
    paint(sceneTime, 0, reduced.matches);
  });
  ro.observe(container);

  // Repaint once the webfonts land, which is always after first paint. Canvas text
  // is rasterized at draw time with no reflow behind it, so a frame painted before
  // the swap keeps its fallback font for as long as it is on screen -- and under
  // reduced motion that is one frame, forever. The `disposed` guard matters
  // because this is the one async path the disposer cannot cancel: `mount` tears
  // down on `astro:before-swap`, and measuring a detached canvas would resize the
  // scene to 1x1.
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
