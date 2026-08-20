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

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the hero's own content sits, in canvas-local CSS pixels, and the clear
 * space around it.
 *
 * A backdrop that draws under the headline and the example windows is not a
 * backdrop, it is a collision. The harness measures the real boxes rather than
 * guessing fractions of the viewport, because the content is a centred column
 * whose width is capped in `rem` and therefore moves against the viewport at
 * every breakpoint and every root font size.
 *
 * The clear space is deliberately *not* a single pair of gutters beside the
 * union of the boxes. Measured at 1440px, the union is 976px wide and leaves
 * 213px a side, but that width belongs only to the illustration in the top
 * third: below it the copy narrows to 576px and the real clear column is 429px.
 * Taking the union would throw away half the usable canvas, and at 1024px it
 * would report 8px and every scene would hide. So scenes ask for the clear
 * columns beside a specific horizontal band, via `sideBands`.
 */
export interface KeepOut {
  /** Every measured content box. */
  boxes: Rect[];
  /** The subset that is bare text on the page background, with nothing behind it. */
  bareText: Rect[];
  /** Union of them all. Useful for "is this point over the copy at all". */
  box: Rect;
  /**
   * The widest single box, which is the illustration. Scenes that want the roomy
   * lower columns start their band just below this.
   */
  widest: Rect;
  /** Full-canvas-width clear strip above all content. Measured at 96 to 128px tall. */
  bandTop: Rect;
  /**
   * The widest clear column each side of the content that intersects
   * `y .. y + height`. A zero-width rect means there is no room on that side.
   */
  sideBands(y: number, height: number): { left: Rect; right: Rect };
  /** True when the rect touches any content box. */
  hits(r: Rect): boolean;
  /**
   * How freely a scene may draw at a point: 1 in the open, 0 under bare text,
   * ramped over a feather in between.
   *
   * This is for the scenes that are an ambient texture rather than a diagram.
   * They are *supposed* to cover the whole canvas, so they cannot simply lay
   * themselves out in a clear column, and cutting a hard rectangle out of a star
   * field reads as a missing rectangle, which is worse than the collision. Note
   * that only bare text counts: ink behind the code windows is invisible, because
   * the windows are an opaque panel.
   */
  clarity(x: number, y: number): number;
}

export interface SceneContext {
  ctx: CanvasRenderingContext2D;
  size: SceneSize;
  keepOut: KeepOut;
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
  /**
   * True for a scene that is a texture over the whole canvas rather than a
   * diagram placed in the clear space.
   *
   * The harness clips bare text out of an ambient scene, which is a hard
   * guarantee that `clarity`'s feather cannot give on its own: a 4px node square
   * whose centre is 3px outside the headline still puts a column of pixels
   * inside it. Diagram scenes are deliberately *not* clipped, so that a label
   * drifting onto the copy shows up as a collision to be fixed rather than being
   * silently truncated.
   */
  ambient?: boolean;
  /** Called once per size change, before the next draw. Scenes lay out here. */
  layout?(size: SceneSize, keepOut: KeepOut): void;
  /**
   * False when the last `layout` left the scene no room to draw legibly.
   *
   * The four diagram scenes are monospace text at a size derived from the clear
   * column, and below about 1280px there is no width at which 68 characters of
   * JSON and the hero copy both fit. Rather than clip, they say so, and the
   * harness substitutes the ambient field: a hero should never have a dead
   * backdrop, least of all on the commonest class of viewport.
   */
  fits?(): boolean;
  draw(c: SceneContext): void;
}

export type SceneFactory = () => Scene;
