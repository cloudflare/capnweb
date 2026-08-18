/**
 * Scene 1: a drifting node field crossed by single round trips.
 *
 * The field itself lives in `field.ts`, shared with the `/1a`../`/1e` variations.
 * What is layered on top is the part that is ours. Proteus draws a field that only
 * shimmers. Here the field is a network, and traffic crosses it as a *round trip*:
 * a train of requests leaves a client node, walks the graph to a server node, the
 * server flashes once, and a single response walks back along the identical path.
 * Out and back, once. The train is the point: four or five calls ride together in
 * the outbound leg, because in Cap'n Web a chain of dependent calls is still one
 * trip, and the returning payload is single.
 *
 * Docs: `start/pipelining-tour.md` (The trick), `concepts/promises.md`
 * (Awaiting is what costs a round trip).
 */
import type { Scene, SceneSize } from "../types";
import { Field } from "./field";

type Phase = "out" | "work" | "back" | "done";

interface Trip {
  /** Node indices, client first, server last. Positions are read live. */
  path: number[];
  /** Each path node's `gen` when the trip spawned. See `FieldNode.gen`. */
  gen: number[];
  phase: Phase;
  /** 0..1 within the current phase. */
  p: number;
  /** How many calls ride the outbound leg. */
  calls: number;
  /** Fades the whole trip in and out so it does not pop. */
  age: number;
}

const OUT_SECS = 1.5;
const WORK_SECS = 0.28;
const BACK_SECS = 1.1;
const SPAWN_EVERY = 1.15;
const MAX_TRIPS = 3;

export function roundTripField(): Scene {
  const field = new Field();
  let trips: Trip[] = [];
  let sinceSpawn = SPAWN_EVERY;

  const newTrip = (path: number[], phase: Phase = "out", p = 0, age = 0): Trip => ({
    path,
    gen: field.gensOf(path),
    phase,
    p,
    // Four or five pushes in the train: the tour's example is five calls.
    calls: 4 + Math.floor(Math.random() * 2),
    age,
  });

  const layout = (s: SceneSize) => {
    field.layout(s);
    // Anything routed through a node that no longer exists has to go.
    trips = trips.filter((t) => t.path.every((i) => i < field.nodes.length));
  };

  const advance = (dt: number) => {
    field.advance(dt);

    sinceSpawn += dt;
    if (sinceSpawn >= SPAWN_EVERY && trips.length < MAX_TRIPS) {
      sinceSpawn = 0;
      const path = field.findPath();
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
      if (field.wrapped(trip.path, trip.gen)) trip.phase = "done";
    }
    trips = trips.filter((t) => t.phase !== "done");
  };

  return {
    // A texture over the whole canvas, so the harness clips the copy out of it.
    ambient: true,
    layout,
    draw(c) {
      const { ctx, palette } = c;
      field.clarity = c.keepOut.clarity;
      if (c.still && trips.length === 0) {
        // A composed still: one trip caught mid-return, so both legs are legible.
        const path = field.findPath();
        if (path) trips = [newTrip(path, "back", 0.45, 1)];
      }
      if (!c.still) advance(c.dt);
      field.draw(ctx, palette);

      for (const trip of trips) {
        const total = field.pathLength(trip.path);
        if (total <= 0) continue;
        const fade = Math.min(1, trip.age / 0.35);
        const client = trip.path[0]!;
        const server = trip.path[trip.path.length - 1]!;

        field.drawRoute(ctx, palette, trip.path, 0.4 * fade);
        field.drawEndpoint(ctx, client, palette.request);

        if (trip.phase === "out") {
          // The train: `calls` pushes riding one trip, tight together, the leader
          // brightest. Written back to back, they never wait for each other.
          const head = total * trip.p;
          for (let k = 0; k < trip.calls; k++) {
            const d = head - k * 11;
            if (d < 0) continue;
            const a = fade * (1 - k / (trip.calls + 1)) * 0.95;
            field.dot(ctx, field.pointAt(trip.path, d), palette.request, a, 1.6);
          }
          field.drawEndpoint(ctx, server, palette.stroke);
        } else if (trip.phase === "work") {
          // One flash at the far end: the whole chain evaluates there.
          field.drawEndpoint(ctx, server, palette.response, Math.sin(trip.p * Math.PI));
        } else {
          // One response comes back. Not a train: the chain resolved to a value.
          const d = total * (1 - trip.p);
          const pt = field.pointAt(trip.path, d);
          field.dot(ctx, pt, palette.response, fade);
          // A short comet tail, pointing the way it is going.
          const tail = field.pointAt(trip.path, Math.min(total, d + 14));
          const m = field.clarity(pt.x, pt.y);
          ctx.strokeStyle = palette.response;
          ctx.globalAlpha = fade * 0.5 * m;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(pt.x, pt.y);
          ctx.lineTo(tail.x, tail.y);
          ctx.stroke();
          ctx.globalAlpha = 1;
          field.drawEndpoint(ctx, server, palette.stroke);
        }
      }
    },
  };
}
