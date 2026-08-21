/**
 * The contract between the canvas hero harness and a scene.
 *
 * A scene owns nothing but drawing. The harness owns the canvas, the device
 * pixel ratio, resize, pausing, the palette, and the reduced-motion path, so
 * five scenes cannot drift into five different sets of lifecycle bugs.
 */

/** Resolved from CSS custom properties, so a scene never hardcodes a colour. */
export interface Palette {
  /**
   * True when `data-theme="light"` is on `<html>`.
   *
   * There is deliberately no background colour here. A scene must never fill one:
   * the harness clears to transparent so the canvas composites over
   * `.cw-hero-field`'s radial pool and under `.cw-hero-veil`, and an opaque fill
   * would erase the stage the whole backdrop is composed against.
   */
  light: boolean;
  /** Structural line work: cables, table rules, node links. */
  stroke: string;
  /** The same colour as `stroke`, as `"r g b"`, for scenes that need alphas. */
  strokeRgb: string;
  /** A request travelling away from its origin. */
  request: string;
  /** A response coming back. Deliberately distinct from `request`. */
  response: string;
  /** Quiet text: annotations, counts. */
  muted: string;
  /**
   * Full-strength body text.
   *
   * Only the foreground figure needs this. A backdrop scene has no business
   * drawing at full contrast -- it sits behind the copy and under a veil -- but
   * `/9` puts its diagram in the flow as real content, where a label rendered in
   * `muted` on the page background is a legibility problem rather than a
   * tasteful one.
   */
  foreground: string;
  /** Something being retired: a release, a disposal, a dropped reply. */
  fade: string;
  /** `--nb-font-mono`, for the scenes that draw real wire messages. */
  mono: string;
  /** `--nb-font-sans`, for the figure's headings and its verdicts. */
  sans: string;
}

export interface SceneSize {
  /** CSS pixels. The context is already scaled, so scenes work in these. */
  width: number;
  height: number;
}

export interface SceneContext {
  ctx: CanvasRenderingContext2D;
  size: SceneSize;
  palette: Palette;
  /** Seconds since the scene started. Monotonic, and it does not advance while paused. */
  t: number;
  /** Seconds since the previous frame, clamped so a long pause cannot jump the state. */
  dt: number;
  /**
   * True when the harness only wants one frame, because the visitor asked for
   * reduced motion. Scenes should draw a composed, readable still: the moment in
   * the story that explains the most, not frame zero of the loop.
   */
  still: boolean;
}

export interface Scene {
  /** Called once per size change, before the next draw. Scenes lay out here. */
  layout?(size: SceneSize): void;
  draw(c: SceneContext): void;
}

export type SceneFactory = () => Scene;
