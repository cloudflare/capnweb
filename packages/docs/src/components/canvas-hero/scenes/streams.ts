/**
 * Scene 1e: several streams sharing one cable, each running at its own rate.
 *
 * Every other scene in this family draws traffic as discrete marks, because every
 * other scene is about individual calls. This one is about flow, so it is drawn as
 * flow: continuous dashed ribbons rather than dots, moving without beginning or
 * end. That difference in motion is the fastest way to tell this hero from the
 * others at a glance, before any detail resolves.
 *
 * Three ribbons run along a shared trunk and separate at the fork. On the trunk
 * they are drawn as parallel offsets a couple of pixels apart, so the cable is
 * visibly carrying all three at once rather than taking turns: one connection,
 * many independent conversations. Their speeds differ and drift slowly, because
 * they are independent -- a slow consumer on one stream does not slow the others.
 *
 * Docs: `concepts/streaming.md` (streams over a session), `guides/sessions.md`
 * (one connection multiplexes everything).
 */
import type { Scene, SceneSize } from "../types";
import { Field, type Point } from "./field";

interface Ribbon {
  /** Trunk then branch, as one path. The trunk prefix is shared with the others. */
  path: number[];
  /** Perpendicular offset in pixels, so the shared trunk shows three cables. */
  lane: number;
  /** Pixels per second along the path. */
  speed: number;
  /** Distance travelled, which is just the dash offset. */
  flow: number;
  /** Independent rate wobble, so no two ever lock into step. */
  wobble: number;
}

/** Dash geometry, in pixels. Long marks read as flow; short ones read as dots. */
const DASH = 9;
const GAP = 7;
const TRUNK_LEN = 3;

export function streams(): Scene {
  const field = new Field();
  let ribbons: Ribbon[] = [];
  let trunk: number[] = [];
  let gen: number[] = [];
  let age = 0;
  let life = 0;

  const allNodes = () => [...new Set(ribbons.flatMap((r) => r.path))];

  /** A trunk, then up to three branches off its far end. */
  const build = () => {
    ribbons = [];
    trunk = [];
    for (let attempt = 0; attempt < 10 && ribbons.length < 2; attempt++) {
      const t = field.findPath(TRUNK_LEN, TRUNK_LEN);
      if (!t) continue;
      const fork = t[t.length - 1]!;
      const found: Ribbon[] = [];
      const taken = new Set<number>(t);
      for (let k = 0; k < 8 && found.length < 3; k++) {
        const branch = field.findPath(2, 2, fork);
        if (!branch) continue;
        const tip = branch[branch.length - 1]!;
        if (taken.has(tip)) continue;
        taken.add(tip);
        found.push({
          // `branch` starts at the fork, which the trunk already ends on.
          path: [...t, ...branch.slice(1)],
          lane: 0,
          speed: 34 + Math.random() * 26,
          flow: Math.random() * 200,
          wobble: Math.random() * Math.PI * 2,
        });
      }
      if (found.length >= 2) {
        trunk = t;
        ribbons = found;
      }
    }
    if (ribbons.length > 0) {
      // Centre the lanes on the cable: -2.5, 0, +2.5 for three.
      const mid = (ribbons.length - 1) / 2;
      ribbons.forEach((r, i) => {
        r.lane = (i - mid) * 2.6;
      });
      gen = field.gensOf(allNodes());
      age = 0;
      life = 0;
    }
  };

  /**
   * The path offset sideways by `lane` pixels.
   *
   * Each vertex moves along the average of the normals of the segments meeting
   * there, which keeps the three ribbons parallel through a corner instead of
   * letting them cross on the inside of the bend.
   */
  const offsetPoints = (path: number[], lane: number): Point[] => {
    const pts = path.map((i) => field.nodes[i]!).map((n) => ({ x: n.x, y: n.y }));
    if (lane === 0) return pts;
    const normals: Point[] = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const dx = pts[k + 1]!.x - pts[k]!.x;
      const dy = pts[k + 1]!.y - pts[k]!.y;
      const len = Math.hypot(dx, dy) || 1;
      normals.push({ x: -dy / len, y: dx / len });
    }
    return pts.map((pt, k) => {
      const a = normals[Math.max(0, k - 1)]!;
      const b = normals[Math.min(normals.length - 1, k)]!;
      const nx = (a.x + b.x) / 2;
      const ny = (a.y + b.y) / 2;
      const len = Math.hypot(nx, ny) || 1;
      return { x: pt.x + (nx / len) * lane, y: pt.y + (ny / len) * lane };
    });
  };

  return {
    ambient: true,
    layout(s: SceneSize) {
      field.layout(s);
      if (ribbons.length > 0 && allNodes().some((i) => i >= field.nodes.length)) ribbons = [];
    },
    draw(c) {
      const { ctx, palette } = c;
      field.clarity = c.keepOut.clarity;

      if (!c.still) {
        field.advance(c.dt);
        age += c.dt;
        life += c.dt;
        for (const r of ribbons) {
          // A slow breathing rate difference, never enough to stall a ribbon.
          const rate = r.speed * (1 + Math.sin(life * 0.5 + r.wobble) * 0.28);
          r.flow += rate * c.dt;
        }
        // Long-lived, because a stream that keeps restarting is not a stream.
        if (life > 14) ribbons = [];
      }

      if (ribbons.length === 0) build();
      if (ribbons.length > 0 && field.wrapped(allNodes(), gen)) ribbons = [];

      field.draw(ctx, palette);
      if (ribbons.length === 0) return;

      const fade = c.still ? 1 : Math.min(1, age / 0.5);
      // The cable itself, under the traffic.
      field.drawRoute(ctx, palette, trunk, 0.34 * fade);
      for (const r of ribbons) field.drawRoute(ctx, palette, r.path.slice(TRUNK_LEN - 1), 0.26 * fade);

      ctx.setLineDash([DASH, GAP]);
      ctx.lineWidth = 1.8;
      ctx.lineCap = "butt";
      for (let i = 0; i < ribbons.length; i++) {
        const r = ribbons[i]!;
        const pts = offsetPoints(r.path, r.lane);
        // Alternating colours so the three are separable where they run parallel.
        ctx.strokeStyle = i % 2 === 0 ? palette.request : palette.response;
        let travelled = 0;
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1]!;
          const b = pts[k]!;
          const seg = Math.hypot(b.x - a.x, b.y - a.y);
          const m = field.lineClarity(a, b);
          if (m > 0.01) {
            // Each segment is stroked on its own so it can carry its own dimming,
            // so the dash phase has to be carried across the joins by hand.
            ctx.lineDashOffset = -(r.flow + travelled);
            ctx.globalAlpha = 0.8 * fade * m;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
          travelled += seg;
        }
      }
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.globalAlpha = 1;

      // The endpoints: one source, and a consumer on the end of every branch.
      field.drawEndpoint(ctx, trunk[0]!, palette.request, 0, fade);
      for (const r of ribbons) field.drawEndpoint(ctx, r.path[r.path.length - 1]!, palette.stroke, 0, fade);
    },
  };
}
