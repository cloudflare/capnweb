/**
 * Scene 1: a drifting node field crossed by single round trips.
 *
 * The substrate is modelled on the canvas behind proteus.ashishkumarsingh.com:
 * a slow drift of small square nodes, wrapping at the edges, with a link drawn
 * between any two that come within a threshold and its alpha falling off with
 * distance. Those specifics are the look, so they are kept: squares rather than
 * circles, one shared threshold, links faded by proximity, and the same node
 * count curve (one node per 24px of width, clamped).
 *
 * What is layered on top is the part that is ours. Proteus draws a field that
 * only shimmers. Here the field is a network, and traffic crosses it as a *round
 * trip*: a train of requests leaves a client node, walks the graph to a server
 * node, the server flashes once, and a single response walks back along the
 * identical path. Out and back, once. The train is the point: four or five calls
 * ride together in the outbound leg, because in Cap'n Web a chain of dependent
 * calls is still one trip, and the returning payload is single.
 *
 * Docs: `start/pipelining-tour.md` (The trick), `concepts/promises.md`
 * (Awaiting is what costs a round trip).
 */
import type { Scene, SceneContext, SceneSize } from "../types";

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Bumped every time the node wraps an edge. See `Trip.gen`. */
  gen: number;
}

type Phase = "out" | "work" | "back" | "done";

interface Trip {
  /** Node indices, client first, server last. Positions are read live. */
  path: number[];
  /**
   * Each path node's `gen` when the trip spawned.
   *
   * Positions are read live so a trip bends with the drifting field, which is the
   * effect worth having. The cost is that a node wrapping from one edge to the
   * other mid-trip turns one segment into a canvas-width line and teleports the
   * travelling dot across the hero in a single frame. Any node within a couple of
   * dozen pixels of an edge will wrap inside a 2.9s trip, so this is a matter of
   * time, not a corner case. Comparing generations retires the trip instead.
   */
  gen: number[];
  phase: Phase;
  /** 0..1 within the current phase. */
  p: number;
  /** How many calls ride the outbound leg. */
  calls: number;
  /** Fades the whole trip in and out so it does not pop. */
  age: number;
}

/** Link distance, in CSS pixels. Proteus uses 170 and it reads well. */
const LINK_DIST = 170;
/** Proteus drifts at 0.28 px per frame; expressed per second so dt drives it. */
const DRIFT = 0.28 * 60;
const MARGIN = 20;

const OUT_SECS = 1.5;
const WORK_SECS = 0.28;
const BACK_SECS = 1.1;
const SPAWN_EVERY = 1.15;
const MAX_TRIPS = 3;

export function roundTripField(): Scene {
  let nodes: Node[] = [];
  let size: SceneSize = { width: 1, height: 1 };
  let trips: Trip[] = [];
  let sinceSpawn = SPAWN_EVERY;
  // Deterministic enough to look organic, without a seeded-RNG dependency.
  const rand = () => Math.random();

  const newTrip = (path: number[], phase: Phase = "out", p = 0, age = 0): Trip => ({
    path,
    gen: path.map((i) => nodes[i]?.gen ?? 0),
    phase,
    p,
    // Four or five pushes in the train: the tour's example is five calls.
    calls: 4 + Math.floor(rand() * 2),
    age,
  });

  const spawnNode = (s: SceneSize): Node => ({
    x: rand() * s.width,
    y: rand() * s.height,
    vx: (rand() - 0.5) * DRIFT,
    vy: (rand() - 0.5) * DRIFT,
    gen: 0,
  });

  /**
   * Rescale in place rather than re-seed.
   *
   * `layout` runs on every `ResizeObserver` tick and once more when the webfonts
   * land, which is always after first paint. Reallocating the field there made the
   * whole thing visibly reshuffle a few hundred milliseconds into every visit, and
   * re-seed on every frame of a window drag. Existing nodes keep their identity, so
   * the field stretches with the canvas and trips in progress stay valid.
   */
  const layout = (s: SceneSize) => {
    const prev = size;
    size = s;
    const count = Math.max(26, Math.min(58, Math.floor(s.width / 24)));
    const sx = prev.width > 1 ? s.width / prev.width : 1;
    const sy = prev.height > 1 ? s.height / prev.height : 1;
    for (const n of nodes) {
      n.x *= sx;
      n.y *= sy;
    }
    if (nodes.length > count) {
      nodes.length = count;
      // Anything routed through a node that no longer exists has to go.
      trips = trips.filter((t) => t.path.every((i) => i < count));
    }
    while (nodes.length < count) nodes.push(spawnNode(s));
  };

  /** Current neighbours of `i` within the link threshold. */
  const neighbours = (i: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < nodes.length; j++) {
      if (j === i) continue;
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      if (dx * dx + dy * dy < LINK_DIST * LINK_DIST) out.push(j);
    }
    return out;
  };

  /**
   * A path of 3 to 5 nodes, so the trip visibly *traverses* rather than hopping
   * one link. Breadth-first from a random start, taking the first frontier that
   * is far enough out; returns null when the field is too sparse right now,
   * which simply means no trip spawns this tick.
   */
  const findPath = (): number[] | null => {
    if (nodes.length < 4) return null;
    const start = Math.floor(rand() * nodes.length);
    const prev = new Map<number, number>([[start, -1]]);
    let frontier = [start];
    for (let depth = 1; depth <= 4; depth++) {
      const next: number[] = [];
      for (const i of frontier) {
        for (const j of neighbours(i)) {
          if (prev.has(j)) continue;
          prev.set(j, i);
          next.push(j);
        }
      }
      if (next.length === 0) break;
      frontier = next;
      // Depth 3 is the shortest that reads as a traversal; take it or go deeper.
      if (depth >= 3 && rand() < 0.6) break;
    }
    if (frontier.length === 0 || frontier[0] === start) return null;
    const end = frontier[Math.floor(rand() * frontier.length)];
    const path: number[] = [];
    for (let at: number | undefined = end; at !== undefined && at !== -1; at = prev.get(at)) {
      path.push(at);
    }
    path.reverse();
    return path.length >= 3 ? path : null;
  };

  /** Total length of the live polyline through a trip's path. */
  const pathLength = (path: number[]): number => {
    let total = 0;
    for (let k = 1; k < path.length; k++) {
      total += Math.hypot(nodes[path[k]].x - nodes[path[k - 1]].x, nodes[path[k]].y - nodes[path[k - 1]].y);
    }
    return total;
  };

  /** Point at `d` pixels along the live polyline. */
  const pointAt = (path: number[], d: number): { x: number; y: number } => {
    let travelled = 0;
    for (let k = 1; k < path.length; k++) {
      const a = nodes[path[k - 1]];
      const b = nodes[path[k]];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (travelled + seg >= d || k === path.length - 1) {
        const f = seg === 0 ? 0 : Math.max(0, Math.min(1, (d - travelled) / seg));
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
      travelled += seg;
    }
    const last = nodes[path[path.length - 1]];
    return { x: last.x, y: last.y };
  };

  const advance = (dt: number) => {
    for (const n of nodes) {
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      if (n.x < -MARGIN) {
        n.x = size.width + MARGIN;
        n.gen++;
      } else if (n.x > size.width + MARGIN) {
        n.x = -MARGIN;
        n.gen++;
      }
      if (n.y < -MARGIN) {
        n.y = size.height + MARGIN;
        n.gen++;
      } else if (n.y > size.height + MARGIN) {
        n.y = -MARGIN;
        n.gen++;
      }
    }

    sinceSpawn += dt;
    if (sinceSpawn >= SPAWN_EVERY && trips.length < MAX_TRIPS) {
      sinceSpawn = 0;
      const path = findPath();
      if (path) trips.push(newTrip(path));
    }

    for (const trip of trips) {
      trip.age += dt;
      const dur = trip.phase === "out" ? OUT_SECS : trip.phase === "work" ? WORK_SECS : BACK_SECS;
      trip.p += dt / dur;
      if (trip.p >= 1) {
        trip.p = 0;
        trip.phase = trip.phase === "out" ? "work" : trip.phase === "work" ? "back" : "done";
      }
      // A node under this trip wrapped to the far edge, so the route it was using
      // no longer exists in any meaningful sense. Retire it rather than draw a
      // dot jumping the width of the hero.
      if (trip.path.some((i, k) => nodes[i]?.gen !== trip.gen[k])) trip.phase = "done";
    }
    trips = trips.filter((t) => t.phase !== "done");
  };

  /**
   * How visible the field may be at a point, and along a line.
   *
   * The field is ambient and covers the whole canvas, which is the reference's
   * whole character, so it cannot be laid out in a clear column like the diagram
   * scenes. Instead it dims to nothing under the headline, the tagline and the
   * buttons. A link is sampled at both ends and the middle, because a 170px link
   * can straddle the copy with both endpoints outside it.
   */
  let clarity: (x: number, y: number) => number = () => 1;
  const lineClarity = (ax: number, ay: number, bx: number, by: number) =>
    Math.min(clarity(ax, ay), clarity(bx, by), clarity((ax + bx) / 2, (ay + by) / 2));

  const drawField = (c: SceneContext) => {
    const { ctx, palette } = c;
    // Links first, so nodes sit on top of them. Alpha rides `globalAlpha` and the
    // colour is set once: with 58 nodes this loop runs ~1,650 times a frame, and a
    // template-string `strokeStyle` per link is 1,650 allocations and CSS colour
    // parses a frame to express a number the context already takes directly.
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgb(${palette.strokeRgb})`;
    // Proteus fades to 0.22 at its brightest; ink on paper needs a little more to
    // survive, so light gets a higher ceiling.
    const peak = palette.light ? 0.34 : 0.26;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d >= LINK_DIST) continue;
        const m = lineClarity(a.x, a.y, b.x, b.y);
        if (m <= 0.01) continue;
        ctx.globalAlpha = (1 - d / LINK_DIST) * peak * m;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // Squares, not circles. That is the reference's signature.
    ctx.fillStyle = `rgb(${palette.strokeRgb} / ${palette.light ? 0.8 : 0.62})`;
    for (const n of nodes) {
      const m = clarity(n.x, n.y);
      if (m <= 0.01) continue;
      ctx.globalAlpha = m;
      ctx.fillRect(n.x - 2, n.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  };

  const drawEndpoint = (c: SceneContext, i: number, colour: string, glow: number) => {
    const { ctx } = c;
    const n = nodes[i];
    const m = clarity(n.x, n.y);
    if (m <= 0.01) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.9 * m;
    const r = 5 + glow * 4;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = m;
    ctx.fillStyle = colour;
    ctx.fillRect(n.x - 2.5, n.y - 2.5, 5, 5);
    ctx.globalAlpha = 1;
  };

  const drawTrips = (c: SceneContext) => {
    const { ctx, palette } = c;
    for (const trip of trips) {
      const total = pathLength(trip.path);
      if (total <= 0) continue;
      const fade = Math.min(1, trip.age / 0.35);
      const client = trip.path[0];
      const server = trip.path[trip.path.length - 1];

      // The route the trip is using, brought up out of the field. Stroked per
      // segment rather than as one path, so each segment can carry its own dimming
      // where it passes the copy.
      ctx.lineWidth = 1;
      for (let k = 1; k < trip.path.length; k++) {
        const a = nodes[trip.path[k - 1]];
        const b = nodes[trip.path[k]];
        const m = lineClarity(a.x, a.y, b.x, b.y);
        if (m <= 0.01) continue;
        ctx.strokeStyle = `rgb(${palette.strokeRgb} / ${(0.4 * fade * m).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      drawEndpoint(c, client, palette.request, 0);

      if (trip.phase === "out") {
        // The train: `calls` pushes riding one trip, tight together, the leader
        // brightest. Written back to back, they never wait for each other.
        const head = total * trip.p;
        for (let k = 0; k < trip.calls; k++) {
          const d = head - k * 11;
          if (d < 0) continue;
          const pt = pointAt(trip.path, d);
          ctx.globalAlpha = fade * (1 - k / (trip.calls + 1)) * 0.95 * clarity(pt.x, pt.y);
          ctx.fillStyle = palette.request;
          ctx.fillRect(pt.x - 1.6, pt.y - 1.6, 3.2, 3.2);
        }
        ctx.globalAlpha = 1;
        drawEndpoint(c, server, palette.stroke, 0);
      } else if (trip.phase === "work") {
        // One flash at the far end: the whole chain evaluates there.
        const pulse = Math.sin(trip.p * Math.PI);
        drawEndpoint(c, server, palette.response, pulse);
      } else {
        // One response comes back. Not a train: the chain resolved to a value.
        const d = total * (1 - trip.p);
        const pt = pointAt(trip.path, d);
        const m = clarity(pt.x, pt.y);
        ctx.globalAlpha = fade * m;
        ctx.fillStyle = palette.response;
        ctx.fillRect(pt.x - 2, pt.y - 2, 4, 4);
        // A short comet tail, pointing the way it is going.
        const tail = pointAt(trip.path, Math.min(total, d + 14));
        ctx.strokeStyle = palette.response;
        ctx.globalAlpha = fade * 0.5 * m;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(tail.x, tail.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        drawEndpoint(c, server, palette.stroke, 0);
      }
      ctx.globalAlpha = 1;
    }
  };

  return {
    // A texture over the whole canvas, so the harness clips the copy out of it.
    ambient: true,
    layout,
    draw(c) {
      clarity = c.keepOut.clarity;
      if (c.still) {
        // A composed still: the field, plus one trip caught mid-return so both
        // legs are legible at once.
        if (trips.length === 0) {
          const path = findPath();
          if (path) trips = [newTrip(path, "back", 0.45, 1)];
        }
        drawField(c);
        drawTrips(c);
        return;
      }
      advance(c.dt);
      drawField(c);
      drawTrips(c);
    },
  };
}
