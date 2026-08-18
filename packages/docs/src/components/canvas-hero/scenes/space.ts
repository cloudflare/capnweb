/**
 * Where in the canvas a scene is allowed to draw.
 *
 * Four of the five scenes are diagrams made of monospace text, and they all want
 * the same two things: a pair of readable columns, and a lane for the one message
 * that has to cross between them. Measured at 1440px the hero leaves 413px a
 * side *below the illustration* but only 213px beside it, and a full-width strip
 * 128px tall above it. So the columns go low and the lane goes high, and this
 * module is the single place that decides that, rather than four scenes each
 * inventing their own fractions.
 */

import type { KeepOut, Rect, SceneSize } from "../types";

export interface Space {
  /** Readable column, left of the copy, below the illustration. */
  left: Rect;
  /** The same on the right. */
  right: Rect;
  /** Full-width clear strip above all content, for messages in flight. */
  band: Rect;
  /** Horizontal extent of the content the lane crosses. */
  crossX0: number;
  crossX1: number;
  /** Centre of the canvas, where a lane's label goes. */
  midX: number;
}

export function space(size: SceneSize, k: KeepOut): Space {
  // Start below the illustration, which is the only wide box.
  const y = k.widest.y + k.widest.height + 20;
  const h = Math.max(0, size.height - y - 8);
  const { left, right } = k.sideBands(y, h);
  return {
    left,
    right,
    band: k.bandTop,
    crossX0: Math.max(0, k.box.x - 2),
    crossX1: Math.min(size.width, k.box.x + k.box.width + 2),
    midX: size.width / 2,
  };
}

/**
 * The type size at which `chars` monospace characters fit `width`.
 *
 * 0.6em is the advance width of a monospace glyph in every font this site ships,
 * and these scenes draw real wire messages: a body of clipped JSON says less than
 * no body at all, so the caller hides the scene rather than shrink past legible.
 */
export function fitFont(width: number, chars: number, max = 10.5): number {
  return Math.min(max, (width - 8) / (chars * 0.6));
}
