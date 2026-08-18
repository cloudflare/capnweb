/**
 * The drifting node field, shared by every scene in the `/1` family.
 *
 * The substrate is modelled on the canvas behind proteus.ashishkumarsingh.com: a
 * slow drift of small square nodes wrapping at the edges, with a link drawn
 * between any two that come within a threshold and its alpha falling off with
 * distance. Those specifics are the look, so they are kept: squares rather than
 * circles, one shared threshold, links faded by proximity, and the same node
 * count curve of one node per 24px of width, clamped.
 *
 * Six scenes draw on this field and each says something different on top of it.
 * The field itself is identical in all of them, so it lives here rather than
 * being copied six times with six sets of drifting constants.
 *
 * Everything is masked by `clarity`. The field covers the whole canvas, which is
 * the reference's whole character, so it cannot be laid out in a clear column
 * like the diagram scenes; it dims to nothing under the headline, the tagline and
 * the buttons instead.
 */
import type { Palette, SceneSize } from "../types";

export interface FieldNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /**
   * Bumped every time the node wraps an edge.
   *
   * Anything holding a route reads node positions live, so a route bends as the
   * field drifts, which is the effect worth having. The cost is that a node
   * wrapping from one edge to the other mid-flight turns one segment into a
   * canvas-width line and throws whatever is travelling across the hero in a
   * single frame. Callers snapshot these and retire the route when they change.
   */
  gen: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Link distance, in CSS pixels. Proteus uses 170 and it reads well. */
export const LINK_DIST = 170;
/** Proteus drifts at 0.28px per frame; expressed per second so `dt` drives it. */
const DRIFT = 0.28 * 60;
const MARGIN = 20;

export class Field {
  nodes: FieldNode[] = [];
  size: SceneSize = { width: 1, height: 1 };
  /** Set from `keepOut.clarity` every frame, so scenes never plumb it by hand. */
  clarity: (x: number, y: number) => number = () => 1;

  /** How dense the field is, as pixels of width per node. Higher is sparser. */
  constructor(private readonly spacing = 24) {}

  /**
   * Rescale in place rather than re-seed.
   *
   * `layout` runs on every `ResizeObserver` tick and once more when the webfonts
   * land, which is always after first paint. Reallocating the field there made it
   * visibly reshuffle a few hundred milliseconds into every visit, and re-randomise
   * on every frame of a window drag. Nodes keep their identity, so the field
   * stretches with the canvas and anything in flight stays valid.
   */
  layout(s: SceneSize): void {
    const prev = this.size;
    this.size = s;
    const count = Math.max(22, Math.min(58, Math.floor(s.width / this.spacing)));
    const sx = prev.width > 1 ? s.width / prev.width : 1;
    const sy = prev.height > 1 ? s.height / prev.height : 1;
    for (const n of this.nodes) {
      n.x *= sx;
      n.y *= sy;
    }
    if (this.nodes.length > count) this.nodes.length = count;
    while (this.nodes.length < count) this.nodes.push(this.spawn(s));
  }

  private spawn(s: SceneSize): FieldNode {
    return {
      x: Math.random() * s.width,
      y: Math.random() * s.height,
      vx: (Math.random() - 0.5) * DRIFT,
      vy: (Math.random() - 0.5) * DRIFT,
      gen: 0,
    };
  }

  /** Drifts every node one step and wraps at the edges. */
  advance(dt: number): void {
    for (const n of this.nodes) {
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      if (n.x < -MARGIN) {
        n.x = this.size.width + MARGIN;
        n.gen++;
      } else if (n.x > this.size.width + MARGIN) {
        n.x = -MARGIN;
        n.gen++;
      }
      if (n.y < -MARGIN) {
        n.y = this.size.height + MARGIN;
        n.gen++;
      } else if (n.y > this.size.height + MARGIN) {
        n.y = -MARGIN;
        n.gen++;
      }
    }
  }

  /**
   * A link's visibility, sampled at both ends and the middle.
   *
   * Three samples because a 170px link can straddle the copy with both of its
   * endpoints outside it.
   */
  lineClarity(a: Point, b: Point): number {
    return Math.min(
      this.clarity(a.x, a.y),
      this.clarity(b.x, b.y),
      this.clarity((a.x + b.x) / 2, (a.y + b.y) / 2),
    );
  }

  /** Current neighbours of `i` within the link threshold. */
  neighbours(i: number): number[] {
    const out: number[] = [];
    const from = this.nodes[i];
    if (!from) return out;
    for (let j = 0; j < this.nodes.length; j++) {
      if (j === i) continue;
      const to = this.nodes[j]!;
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      if (dx * dx + dy * dy < LINK_DIST * LINK_DIST) out.push(j);
    }
    return out;
  }

  /**
   * A path of at least `minDepth` hops, so traffic visibly traverses the graph
   * rather than hopping one link.
   *
   * Breadth-first from `start` (random when omitted), taking the first frontier
   * far enough out. Returns null when the field is too sparse right now, which
   * simply means nothing spawns this tick.
   */
  findPath(minDepth = 3, maxDepth = 4, start = Math.floor(Math.random() * this.nodes.length)): number[] | null {
    if (this.nodes.length < 4) return null;
    const prev = new Map<number, number>([[start, -1]]);
    let frontier = [start];
    for (let depth = 1; depth <= maxDepth; depth++) {
      const next: number[] = [];
      for (const i of frontier) {
        for (const j of this.neighbours(i)) {
          if (prev.has(j)) continue;
          prev.set(j, i);
          next.push(j);
        }
      }
      if (next.length === 0) break;
      frontier = next;
      if (depth >= minDepth && Math.random() < 0.6) break;
    }
    if (frontier.length === 0 || frontier[0] === start) return null;
    const end = frontier[Math.floor(Math.random() * frontier.length)]!;
    const path: number[] = [];
    for (let at: number | undefined = end; at !== undefined && at !== -1; at = prev.get(at)) {
      path.push(at);
    }
    path.reverse();
    return path.length >= minDepth ? path : null;
  }

  /**
   * The candidate path, out of `tries`, whose endpoints are furthest apart.
   *
   * `findPath` takes the first route it finds, which is right for anonymous
   * traffic where several trips are in flight and between them they cover the
   * canvas. The scenes that tell one story at a time cannot do that: a single
   * BFS route spans three or four links, which is around a quarter of the hero,
   * and the result was a story happening in one corner with the rest of the
   * field inert. Sampling and keeping the widest costs a few BFS walks per cast
   * and makes the story cross the canvas.
   */
  findSpanningPath(minDepth = 3, maxDepth = 4, tries = 8): number[] | null {
    let best: number[] | null = null;
    let bestSpan = -1;
    for (let k = 0; k < tries; k++) {
      const path = this.findPath(minDepth, maxDepth);
      if (!path) continue;
      const a = this.nodes[path[0]!]!;
      const b = this.nodes[path[path.length - 1]!]!;
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      if (span > bestSpan) {
        bestSpan = span;
        best = path;
      }
    }
    return best;
  }

  /**
   * The shortest path from `from` to `to`, or null when they are not connected
   * within `maxDepth` hops right now.
   *
   * `findPath` picks its own destination, which is fine for anonymous traffic. The
   * scenes with named parties need to route back to a node they already chose.
   */
  pathTo(from: number, to: number, maxDepth = 6): number[] | null {
    if (from === to) return null;
    const prev = new Map<number, number>([[from, -1]]);
    let frontier = [from];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: number[] = [];
      for (const i of frontier) {
        for (const j of this.neighbours(i)) {
          if (prev.has(j)) continue;
          prev.set(j, i);
          if (j === to) {
            const path: number[] = [];
            for (let at: number | undefined = to; at !== undefined && at !== -1; at = prev.get(at)) {
              path.push(at);
            }
            return path.reverse();
          }
          next.push(j);
        }
      }
      frontier = next;
    }
    return null;
  }

  /** The generation of every node on a path, for retiring it after a wrap. */
  gensOf(path: number[]): number[] {
    return path.map((i) => this.nodes[i]?.gen ?? 0);
  }

  /** True when any node on the path has wrapped since `gens` was taken. */
  wrapped(path: number[], gens: number[]): boolean {
    return path.some((i, k) => this.nodes[i]?.gen !== gens[k]);
  }

  /** Total length of the live polyline through a path. */
  pathLength(path: number[]): number {
    let total = 0;
    for (let k = 1; k < path.length; k++) {
      const a = this.nodes[path[k - 1]!]!;
      const b = this.nodes[path[k]!]!;
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return total;
  }

  /** Point at `d` pixels along the live polyline. */
  pointAt(path: number[], d: number): Point {
    let travelled = 0;
    for (let k = 1; k < path.length; k++) {
      const a = this.nodes[path[k - 1]!]!;
      const b = this.nodes[path[k]!]!;
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (travelled + seg >= d || k === path.length - 1) {
        const f = seg === 0 ? 0 : Math.max(0, Math.min(1, (d - travelled) / seg));
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
      travelled += seg;
    }
    const last = this.nodes[path[path.length - 1]!]!;
    return { x: last.x, y: last.y };
  }

  /** The node index nearest a point, for placing a fixed actor in a moving field. */
  nearest(x: number, y: number, exclude: number[] = []): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      if (exclude.includes(i)) continue;
      const n = this.nodes[i]!;
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Links then nodes, both faded by proximity and masked by the copy. */
  draw(ctx: CanvasRenderingContext2D, palette: Palette, dim = 1): void {
    // Alpha rides `globalAlpha` and the colour is set once: with 58 nodes this
    // loop runs ~1,650 times a frame, and a template-string `strokeStyle` per link
    // is 1,650 allocations and CSS colour parses a frame to express a number the
    // context already takes directly.
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgb(${palette.strokeRgb})`;
    // Proteus fades to 0.22 at its brightest; ink on paper needs a little more to
    // survive, so light gets a higher ceiling.
    const peak = (palette.light ? 0.34 : 0.26) * dim;
    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i]!;
      for (let j = i + 1; j < this.nodes.length; j++) {
        const b = this.nodes[j]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d >= LINK_DIST) continue;
        const m = this.lineClarity(a, b);
        if (m <= 0.01) continue;
        ctx.globalAlpha = (1 - d / LINK_DIST) * peak * m;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    // Squares, not circles. That is the reference's signature.
    ctx.fillStyle = `rgb(${palette.strokeRgb} / ${palette.light ? 0.8 : 0.62})`;
    for (const n of this.nodes) {
      const m = this.clarity(n.x, n.y);
      if (m <= 0.01) continue;
      ctx.globalAlpha = m * dim;
      ctx.fillRect(n.x - 2, n.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }

  /** Brings one route up out of the field, per segment so each can dim separately. */
  drawRoute(
    ctx: CanvasRenderingContext2D,
    palette: Palette,
    path: number[],
    alpha: number,
    colour?: string,
  ): void {
    ctx.lineWidth = 1;
    for (let k = 1; k < path.length; k++) {
      const a = this.nodes[path[k - 1]!];
      const b = this.nodes[path[k]!];
      if (!a || !b) continue;
      const m = this.lineClarity(a, b);
      if (m <= 0.01) continue;
      ctx.globalAlpha = alpha * m;
      ctx.strokeStyle = colour ?? `rgb(${palette.strokeRgb})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** A ringed square: an endpoint that matters, as opposed to field furniture. */
  drawEndpoint(
    ctx: CanvasRenderingContext2D,
    i: number,
    colour: string,
    glow = 0,
    alpha = 1,
  ): void {
    const n = this.nodes[i];
    if (!n) return;
    const m = this.clarity(n.x, n.y) * alpha;
    if (m <= 0.01) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.9 * m;
    ctx.beginPath();
    ctx.arc(n.x, n.y, 5 + glow * 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = m;
    ctx.fillStyle = colour;
    ctx.fillRect(n.x - 2.5, n.y - 2.5, 5, 5);
    ctx.globalAlpha = 1;
  }

  /** A small travelling mark, masked where it crosses the copy. */
  dot(ctx: CanvasRenderingContext2D, p: Point, colour: string, alpha: number, r = 2): void {
    const m = this.clarity(p.x, p.y) * alpha;
    if (m <= 0.01) return;
    ctx.globalAlpha = m;
    ctx.fillStyle = colour;
    ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }
}
