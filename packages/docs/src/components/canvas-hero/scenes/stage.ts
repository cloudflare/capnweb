/**
 * The lane stage the three pipelining scenes are drawn on.
 *
 * Those scenes argue about *time*, so they need one axis that runs uninterrupted
 * from a near end to a far end. The only place in the hero with full canvas width
 * and nothing in it is `keepOut.bandTop`, the strip above all the content, so that
 * is where they go. Everything else on the canvas is a dimmed field behind them,
 * which is body rather than content: if the band is thin the scene is still
 * correct, just shorter.
 *
 * Nothing here picks a coordinate. The band comes from the harness's measurement
 * of the real boxes, and the lanes are divided out of whatever it turns out to be.
 */
import type { KeepOut, SceneSize } from "../types";

export interface Stage {
  /** The near end, where calls originate. */
  x0: number;
  /** The far end, where they are executed. */
  x1: number;
  /** Usable width between the two endpoint columns. */
  span: number;
  /** Lane centres, top to bottom, one per requested lane. */
  lanes: number[];
  /** Vertical distance between adjacent lanes. */
  pitch: number;
}

/** Room for the endpoint columns to sit in without touching the canvas edge. */
const EDGE = 28;
/** Below this the band cannot hold legible lanes and the scene should say so. */
export const MIN_PITCH = 13;

export function stage(size: SceneSize, keepOut: KeepOut, laneCount: number): Stage {
  const band = keepOut.bandTop;
  // A band with no measured height yet (first frame, before layout) must not
  // collapse every lane onto one line, so fall back to a sane slice of the canvas.
  const height = band.height > 8 ? band.height : Math.min(120, size.height * 0.2);
  const top = band.height > 8 ? band.y : 0;
  const pitch = height / (laneCount + 1);
  const lanes: number[] = [];
  for (let i = 0; i < laneCount; i++) lanes.push(top + pitch * (i + 1));
  const x0 = EDGE;
  const x1 = Math.max(x0 + 1, size.width - EDGE);
  return { x0, x1, span: x1 - x0, lanes, pitch };
}

/** A vertical tick marking an endpoint column, which is as much as a lane needs. */
export function endpost(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  half: number,
  colour: string,
  alpha: number,
): void {
  if (alpha <= 0.01) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x, y + half);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
