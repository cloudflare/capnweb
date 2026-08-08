/**
 * The node field behind every documentation page.
 *
 * A small object graph in three dimensions, projected to 2D and drawn on a
 * fixed canvas that sits behind the page. Nodes drift, the whole field turns
 * very slowly, and scrolling pushes the near layers further than the far ones,
 * which is what makes it read as depth rather than as wallpaper.
 *
 * It is decorative and it behaves like it: `aria-hidden`, no pointer events,
 * paused when the tab is hidden, static when the reader asks for less motion,
 * and absent entirely if anything here fails. The page is fully legible with
 * nothing painted at all.
 *
 * Deliberately canvas 2D rather than WebGL. The hero needs a shader; this needs
 * about eighty line segments a frame, and a second WebGL context on every page
 * would cost far more than it returns.
 */

interface Node {
	/** Home position in field space, x and y in [-1, 1], z in [0, 1]. */
	x: number;
	y: number;
	z: number;
	/** Drift parameters, so no two nodes move together. */
	phase: number;
	speed: number;
	amp: number;
	radius: number;
}

interface Edge {
	a: number;
	b: number;
	/** Precomputed so the per-frame cost is a lookup rather than a distance. */
	strength: number;
	/** Mean depth of the two endpoints, used to sort the edge into a focus band. */
	midZ: number;
}

/**
 * A message travelling out along one or more edges and back again.
 *
 * `seq` is the whole itinerary, there and back: a trip from `a` to `b` is
 * `[a, b, a]`, and one that carries on to `c` before returning is
 * `[a, b, c, b, a]`. Storing the return legs explicitly rather than reversing at
 * the halfway point means the same code walks both directions.
 */
interface Pulse {
	seq: number[];
	/** The edge each leg travels along, so drawing does not have to look it up. */
	legEdges: number[];
	/** Field time it set off, and how long the whole itinerary takes. */
	born: number;
	duration: number;
	/** Which leg the head was on last frame, used to flash nodes on arrival. */
	leg: number;
	/** Round trips the reader started are brighter than the ambient traffic. */
	gain: number;
}

/** A field: the nodes, the edges, and which edges touch each node. */
interface Field {
	nodes: Node[];
	edges: Edge[];
	/** Indices into `edges` of every edge incident to node i. */
	incident: number[][];
	/** Node pair to edge index, for turning an itinerary into legs. */
	edgeAt: Map<number, number>;
}

type Rgb = [number, number, number];

interface Palette {
	node: Rgb;
	edge: Rgb;
	pulse: Rgb;
	edgeAlpha: number;
	/** 0 on the dark field, 1 on the pale one, tweened across a theme change. */
	light: number;
}

/*
 * The field drifts slowly, and at rest it is a background: thirty frames a
 * second is indistinguishable from sixty and costs half as much. Scrolling and
 * hovering are the two moments a reader is actually watching it move, and there
 * a half-rate field reads as a stutter against smoothly scrolling text, so those
 * get the full rate. A draw costs about 2ms at 1920x1080, so the busy rate is
 * around a tenth of a frame's budget.
 */
const IDLE_FPS = 30;
const ACTIVE_FPS = 60;

/**
 * Field time runs at half the wall clock. Everything derives from `t`, so this
 * one number sets the pace of the drift, the turn, and the pulses together.
 */
const TIME_SCALE = 0.5;

/**
 * Focus bands, far to near. Each is drawn in one pass with a single blur, which
 * is what makes the depth-of-field affordable: the cost is three filter changes
 * a frame rather than one per node.
 */
const BANDS = [
	{ minZ: 0.62, blur: 1.3 },
	{ minZ: 0.3, blur: 0.5 },
	{ minZ: 0, blur: 0 },
];

/** Ambient round trips are an occasional event, not a light show. */
const MAX_AMBIENT_PULSES = 2;
const PULSE_GAP_MIN = 6;
const PULSE_GAP_MAX = 15;

/**
 * Hover. Bring the pointer near a node and that node starts talking to its
 * neighbours: one round trip per edge, and now and then a neighbour passes the
 * message on a further hop before answering.
 *
 * Only ever one node at a time. Lighting up everything the pointer drifts past
 * would turn a background into a toy.
 *
 * Times are in field seconds, which run at `TIME_SCALE`, so a 0.35s leg takes
 * 0.7s on a clock.
 */
const HOVER_RADIUS = 110;
/**
 * How far a node may drift before the pointer lets go of it. Larger than the
 * acquire radius on purpose: the field moves under a stationary pointer, so a
 * single threshold drops the node after a second or two and the reader is left
 * pointing at a dead field.
 */
const HOVER_RELEASE = 190;
/** How much nearer a rival must be to steal the hover, so the pick cannot flicker. */
const HOVER_HANDOVER = 25;
/** Far nodes are out of focus, so a crisp one wins a tie. In pixels of penalty. */
const HOVER_DEPTH_PENALTY = 45;
const HOP_SECONDS = 0.35;
const HOVER_WAVE_GAP = 0.9;
const HOVER_STAGGER = 0.09;
const SECOND_HOP_CHANCE = 0.35;
/**
 * The hover blink, in radians per WALL second, so it is about 1.1 seconds a beat
 * whatever `TIME_SCALE` is doing. The hero uses the same number, since the two
 * highlights should keep time with each other.
 */
const BLINK_RATE = 5.7;

/**
 * Scroll parallax.
 *
 * The offset saturates: it tracks the scroll almost exactly for the first
 * screenful and then stops growing, so the field stays roughly where it started
 * instead of sliding off the top of a long page and leaving nothing but the far,
 * blurred layer huddled in the middle of the screen.
 *
 * The follow is a critically damped spring rather than an exponential ease. An
 * exponential applies its largest correction on the very first frame, which is
 * precisely the jerk a wheel notch produces; a spring starts from rest, so the
 * field takes up the movement and glides. `SCROLL_STIFFNESS` is in radians per
 * second and settles in roughly `4 / k`, so this is a little under half a second.
 */
const SCROLL_SATURATE = 900;
const SCROLL_STIFFNESS = 9;
/** Enough for a well-connected node plus the ambient pair, and no more. */
const MAX_PULSES = 16;

/** Nodes per million device-independent pixels, and the range it is clamped to. */
const NODE_DENSITY = 68;
const MIN_NODES = 34;
const MAX_NODES = 130;

/** Deterministic per-load, so a reload does not reshuffle the composition. */
function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Order-independent key for a node pair. Node counts here are far below 4096. */
const pairKey = (a: number, b: number) => (a < b ? a * 4096 + b : b * 4096 + a);

function buildField(count: number, seed: number): Field {
	const rand = mulberry32(seed);
	const nodes: Node[] = [];

	for (let i = 0; i < count; i++) {
		// Depth is biased towards the back, so the field reads as receding
		// rather than as two flat sheets.
		const z = rand() ** 1.4;
		nodes.push({
			x: rand() * 2 - 1,
			y: rand() * 2 - 1,
			z,
			phase: rand() * Math.PI * 2,
			speed: 0.08 + rand() * 0.12,
			amp: 0.012 + rand() * 0.022,
			radius: 1.2 + (1 - z) * 2.1,
		});
	}

	// Connect each node to its nearest few neighbours. Distance is measured in
	// field space including depth, so the graph does not link things that only
	// look adjacent once flattened.
	const edges: Edge[] = [];
	const seen = new Set<number>();
	for (let i = 0; i < nodes.length; i++) {
		const distances: { j: number; d: number }[] = [];
		for (let j = 0; j < nodes.length; j++) {
			if (i === j) continue;
			const dx = nodes[i]!.x - nodes[j]!.x;
			const dy = nodes[i]!.y - nodes[j]!.y;
			const dz = (nodes[i]!.z - nodes[j]!.z) * 0.9;
			distances.push({ j, d: Math.hypot(dx, dy, dz) });
		}
		distances.sort((p, q) => p.d - q.d);

		const links = 2 + (i % 2);
		for (const { j, d } of distances.slice(0, links)) {
			if (d > 0.62) continue;
			const key = i < j ? i * 4096 + j : j * 4096 + i;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({
				a: i,
				b: j,
				strength: 1 - d / 0.62,
				midZ: (nodes[i]!.z + nodes[j]!.z) / 2,
			});
		}
	}

	// Adjacency, so a hovered node can find its neighbours without a scan, and a
	// pair to edge map, so an itinerary can be turned into legs.
	const incident: number[][] = nodes.map(() => []);
	const edgeAt = new Map<number, number>();
	for (const [index, e] of edges.entries()) {
		incident[e.a]!.push(index);
		incident[e.b]!.push(index);
		edgeAt.set(pairKey(e.a, e.b), index);
	}

	return { nodes, edges, incident, edgeAt };
}

/** Read the field colours from the stylesheet, so themes stay in one place. */
function readPalette(): Palette {
	const s = getComputedStyle(document.documentElement);
	return {
		node: parseHex(s.getPropertyValue('--cw-graph-node'), [108, 194, 251]),
		edge: parseHex(s.getPropertyValue('--cw-graph-edge'), [20, 135, 224]),
		pulse: parseHex(s.getPropertyValue('--cw-graph-pulse'), [201, 120, 46]),
		edgeAlpha: Number(s.getPropertyValue('--cw-graph-edge-alpha')) || 0.17,
		light: document.documentElement.dataset.theme === 'light' ? 1 : 0,
	};
}

function parseHex(raw: string, fallback: Rgb): Rgb {
	const hex = raw.trim();
	const full =
		hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
	if (!/^#[0-9a-f]{6}$/i.test(full)) return fallback;
	return [
		parseInt(full.slice(1, 3), 16),
		parseInt(full.slice(3, 5), 16),
		parseInt(full.slice(5, 7), 16),
	];
}

const mixChannel = (a: number, b: number, u: number) => a + (b - a) * u;

const mixRgb = (a: Rgb, b: Rgb, u: number): Rgb => [
	mixChannel(a[0], b[0], u),
	mixChannel(a[1], b[1], u),
	mixChannel(a[2], b[2], u),
];

/** The bright end of the hover blink. */
const WHITE: Rgb = [255, 255, 255];

export function initGraphBackdrop(canvas: HTMLCanvasElement) {
	const ctx = canvas.getContext('2d', { alpha: true });
	if (!ctx) return;

	const reduced = matchMedia('(prefers-reduced-motion: reduce)');

	// Read from CSS custom properties, and re-read when the theme flips.
	let palette = readPalette();
	let nodes: Node[] = [];
	let edges: Edge[] = [];
	let incident: number[][] = [];
	let edgeAt = new Map<number, number>();
	/** Per-node brightness, 0 to 1, decaying. Raised by hover and by arrivals. */
	let nodeGlow = new Float32Array(0);
	let width = 0;
	let height = 0;
	let dpr = 1;
	let frame = 0;
	let lastDraw = 0;
	/** Where the page actually is, where the field has got to, and the shift the
	    projection uses. All in CSS pixels. */
	let scrollTarget = 0;
	let scrollEased = 0;
	let scrollVel = 0;
	let scrollShift = 0;
	let lastNow = 0;
	let running = false;
	let layer: CanvasRenderingContext2D | null = null;
	const pulses: Pulse[] = [];
	const pulseRand = mulberry32(0xc0ffee);
	let nextPulseAt = PULSE_GAP_MIN;

	// Hover state. `pointerX/Y` are viewport coordinates, which is also canvas
	// space: the canvas is `position: fixed; inset: 0`.
	let pointerX = 0;
	let pointerY = 0;
	let pointerSeen = false;
	let hoverNode = -1;
	/** Eased towards 1 while a node is held, so the halo grows in and out. */
	let hoverEase = 0;
	let nextWaveAt = 0;
	let lastT = 0;

	/**
	 * The offscreen surface the out-of-focus bands are composited from, at half
	 * the resolution of the main canvas. These bands are about to be blurred, so
	 * the detail would be thrown away regardless, and the upscale on composite
	 * softens them a little further for nothing. Quarter of the pixels, and the
	 * blur radius needed on top comes down with it.
	 */
	function getLayer(): CanvasRenderingContext2D | null {
		const w = Math.max(1, Math.ceil(canvas.width / 2));
		const h = Math.max(1, Math.ceil(canvas.height / 2));
		if (layer && layer.canvas.width === w && layer.canvas.height === h) return layer;

		const surface = document.createElement('canvas');
		surface.width = w;
		surface.height = h;
		layer = surface.getContext('2d', { alpha: true });
		layer?.setTransform(dpr / 2, 0, 0, dpr / 2, 0, 0);
		return layer;
	}

	function resize() {
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		if (w === 0 || h === 0) return;

		dpr = Math.min(window.devicePixelRatio || 1, 2);
		width = w;
		height = h;
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

		const count = Math.round(
			Math.max(MIN_NODES, Math.min(MAX_NODES, ((w * h) / 1e6) * NODE_DENSITY))
		);
		if (count !== nodes.length) {
			({ nodes, edges, incident, edgeAt } = buildField(count, 0x5eed));
			nodeGlow = new Float32Array(nodes.length);
			// The old indices meant nothing in the new field.
			pulses.length = 0;
			hoverNode = -1;
			hoverEase = 0;
		}
	}

	/**
	 * Field space to screen. Nearer nodes (low z) are spread wider and pushed
	 * further by scrolling; the far ones barely move at all.
	 */
	function project(n: Node, t: number) {
		const spread = 0.72 + (1 - n.z) * 0.5;
		const wobbleX = Math.sin(t * n.speed + n.phase) * n.amp;
		const wobbleY = Math.cos(t * n.speed * 0.82 + n.phase * 1.3) * n.amp;

		// A slow turn about the vertical axis. Cheap 3D: the x coordinate is
		// rotated against depth, which is enough to see the layers slide past
		// one another without a matrix in sight.
		const turn = t * 0.045;
		const dz = n.z - 0.5;
		const rx = (n.x + wobbleX) * Math.cos(turn) - dz * Math.sin(turn) * 0.55;

		const parallax = (1 - n.z) * 0.16;
		return {
			x: width / 2 + rx * width * 0.5 * spread,
			y: height / 2 + (n.y + wobbleY) * height * 0.62 * spread - scrollShift * parallax,
			// Same depth cue applied to size and opacity.
			fade: 0.35 + (1 - n.z) * 0.65,
		};
	}

	/** The node at the other end of an edge. */
	const otherEnd = (edge: number, from: number) =>
		edges[edge]!.a === from ? edges[edge]!.b : edges[edge]!.a;

	/**
	 * Turn an itinerary into a pulse. Returns null if any leg is not an edge,
	 * which should not happen but is cheaper to check than to reason about.
	 */
	function makePulse(path: number[], born: number, gain: number): Pulse | null {
		if (path.length < 2) return null;
		// There and back: [a,b,c] becomes [a,b,c,b,a].
		const seq = [...path, ...path.slice(0, -1).reverse()];
		const legEdges: number[] = [];
		for (let i = 0; i < seq.length - 1; i++) {
			const edge = edgeAt.get(pairKey(seq[i]!, seq[i + 1]!));
			if (edge === undefined) return null;
			legEdges.push(edge);
		}
		return {
			seq,
			legEdges,
			born,
			duration: legEdges.length * HOP_SECONDS * (0.9 + pulseRand() * 0.25),
			leg: 0,
			gain,
		};
	}

	function addPulse(path: number[], born: number, gain: number) {
		if (pulses.length >= MAX_PULSES) return;
		const pulse = makePulse(path, born, gain);
		if (pulse) pulses.push(pulse);
	}

	/**
	 * Everything the hovered node has to say: one round trip along each of its
	 * edges, staggered so they leave in sequence rather than all at once, and
	 * occasionally one that carries on a further hop before turning back.
	 */
	function emitWave(t: number, from: number) {
		const outgoing = incident[from];
		if (!outgoing) return;

		for (const [i, edge] of outgoing.entries()) {
			const neighbour = otherEnd(edge, from);
			const path = [from, neighbour];

			// Sometimes the neighbour forwards it on. Anywhere but back the way it
			// came, which is what makes it read as a chain rather than a bounce.
			if (pulseRand() < SECOND_HOP_CHANCE) {
				const onward = (incident[neighbour] ?? [])
					.map((e) => otherEnd(e, neighbour))
					.filter((n) => n !== from);
				if (onward.length > 0) {
					path.push(onward[Math.floor(pulseRand() * onward.length)]!);
				}
			}

			addPulse(path, t + i * HOVER_STAGGER, 1);
		}
	}

	/**
	 * Retire finished pulses and occasionally start an ambient one. Ambient edges
	 * are picked from the near half of the field, since a round trip is the one
	 * thing here worth noticing and the far layers are out of focus.
	 */
	function updatePulses(t: number) {
		let ambient = 0;
		for (let i = pulses.length - 1; i >= 0; i--) {
			const pulse = pulses[i]!;
			if (t - pulse.born > pulse.duration) {
				pulses.splice(i, 1);
				continue;
			}
			if (pulse.gain < 1) ambient++;
		}

		if (t < nextPulseAt || ambient >= MAX_AMBIENT_PULSES || edges.length === 0) return;

		let edge = Math.floor(pulseRand() * edges.length);
		for (let attempt = 0; attempt < 6 && edges[edge]!.midZ > 0.55; attempt++) {
			edge = Math.floor(pulseRand() * edges.length);
		}

		// Ambient traffic is slower than anything the reader provokes, and dimmer.
		const pulse = makePulse([edges[edge]!.a, edges[edge]!.b], t, 0.62);
		if (pulse) {
			pulse.duration *= 2.6;
			pulses.push(pulse);
		}
		nextPulseAt = t + PULSE_GAP_MIN + pulseRand() * (PULSE_GAP_MAX - PULSE_GAP_MIN);
	}

	/**
	 * Where a pulse's head is: which leg it is crossing, how far along, and how
	 * bright. Ramped at both ends so it departs and arrives rather than popping.
	 */
	function pulseState(pulse: Pulse, t: number) {
		const legs = pulse.legEdges.length;
		const u = Math.min(1, Math.max(0, (t - pulse.born) / pulse.duration));
		const scaled = u * legs;
		const leg = Math.min(legs - 1, Math.floor(scaled));
		return {
			u,
			leg,
			along: scaled - leg,
			envelope: Math.min(1, u / 0.12, (1 - u) / 0.12),
		};
	}

	/**
	 * Pick the node under the pointer, or -1. Nearest wins, with a penalty on
	 * depth so a node that is in focus is preferred to a blurred one behind it.
	 */
	function pickHovered(points: { x: number; y: number; fade: number }[]) {
		if (!pointerSeen || reduced.matches) return -1;

		const score = (i: number) => {
			const p = points[i]!;
			return Math.hypot(p.x - pointerX, p.y - pointerY) + nodes[i]!.z * HOVER_DEPTH_PENALTY;
		};

		let best = -1;
		let bestScore = HOVER_RADIUS;
		for (let i = 0; i < nodes.length; i++) {
			const s = score(i);
			if (s < bestScore) {
				bestScore = s;
				best = i;
			}
		}

		// Hold on to the node we already have until it is properly gone, or until
		// something else is clearly nearer.
		if (hoverNode >= 0 && hoverNode < nodes.length) {
			const held = score(hoverNode);
			if (held <= HOVER_RELEASE && (best < 0 || bestScore > held - HOVER_HANDOVER)) {
				return hoverNode;
			}
		}

		return best;
	}

	/** Draw the edges and nodes whose depth falls in [minZ, maxZ). */
	function drawBand(
		target: CanvasRenderingContext2D,
		minZ: number,
		maxZ: number,
		points: { x: number; y: number; fade: number }[],
		lit: Map<number, number>,
		glow: boolean
	) {
		target.lineWidth = 1;
		for (const [j, e] of edges.entries()) {
			if (e.midZ < minZ || e.midZ >= maxZ) continue;
			const p = points[e.a]!;
			const q = points[e.b]!;
			const depth = (p.fade + q.fade) / 2;
			const brightness = lit.get(j) ?? 0;
			if (brightness > 0) {
				target.strokeStyle = withAlpha(palette.pulse, 0.9 * brightness * depth);
				target.lineWidth = 1 + brightness;
			} else {
				target.strokeStyle = withAlpha(palette.edge, palette.edgeAlpha * e.strength * depth);
				target.lineWidth = 1;
			}
			target.beginPath();
			target.moveTo(p.x, p.y);
			target.lineTo(q.x, q.y);
			target.stroke();
		}

		// A node in focus gets a little bloom. The blurred bands do not: a glow
		// behind a blur is just a wider blur, at twice the cost.
		if (glow) {
			target.shadowBlur = 5;
			target.shadowColor = withAlpha(palette.node, 0.5);
		}

		for (const [i, n] of nodes.entries()) {
			if (n.z < minZ || n.z >= maxZ) continue;
			// The hovered node is painted last, unblurred, so it stays crisp whichever
			// band it happens to be in.
			if (i === hoverNode) continue;
			const p = points[i]!;
			// A node that has just been reached brightens, swells and takes on the
			// message colour, which is what makes a round trip legible at a glance.
			// Depth still applies: a node at the back does not outshine the front.
			const heat = nodeGlow[i] ?? 0;
			target.fillStyle = withAlpha(
				mixRgb(palette.node, palette.pulse, Math.min(1, heat)),
				(0.36 + 0.5 * heat) * p.fade
			);
			target.beginPath();
			target.arc(p.x, p.y, n.radius * (1 + 0.25 * heat), 0, Math.PI * 2);
			target.fill();
		}

		target.shadowBlur = 0;
		target.shadowColor = 'transparent';
	}

	function draw(now: number) {
		const t = reduced.matches ? 0 : (now / 1000) * TIME_SCALE;
		ctx!.clearRect(0, 0, width, height);

		// Wall-clock step, clamped: the loop can have been parked for minutes. The
		// scroll follow is eased in real seconds rather than field seconds, since it
		// answers to the reader's hand and not to the pace of the field.
		const wallDt = lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0;
		lastNow = now;
		// Semi-implicit Euler on x'' = k^2 (target - x) - 2k x', which is stable for
		// steps well beyond the 100ms the clamp above allows.
		const k = SCROLL_STIFFNESS;
		scrollVel += (k * k * (scrollTarget - scrollEased) - 2 * k * scrollVel) * wallDt;
		scrollEased += scrollVel * wallDt;
		scrollShift = SCROLL_SATURATE * Math.tanh(scrollEased / SCROLL_SATURATE);

		const points = nodes.map((n) => project(n, t));

		// Field time can jump when the loop has been parked, so clamp the step.
		const dt = lastT ? Math.min(0.1, Math.max(0, t - lastT)) : 0;
		lastT = t;

		if (!reduced.matches) {
			updatePulses(t);

			// Hover. A new node under the pointer starts talking immediately; while
			// it is held, it says something again every wave.
			const picked = pickHovered(points);
			if (picked !== hoverNode) {
				hoverNode = picked;
				if (picked >= 0) {
					emitWave(t, picked);
					nextWaveAt = t + HOVER_WAVE_GAP;
				}
			} else if (hoverNode >= 0 && t >= nextWaveAt) {
				emitWave(t, hoverNode);
				nextWaveAt = t + HOVER_WAVE_GAP;
			}

			hoverEase += ((hoverNode >= 0 ? 1 : 0) - hoverEase) * Math.min(1, dt * 9);

			for (let i = 0; i < nodeGlow.length; i++) {
				nodeGlow[i] = Math.max(0, nodeGlow[i]! - dt * 1.5);
			}
			if (hoverNode >= 0) nodeGlow[hoverNode] = 1;
		}

		// Which edges are currently lit, and how brightly. Looked up per edge while
		// drawing, so a pulse can colour the line it is travelling along. Advancing
		// a leg also flashes the node just reached, which is what makes a chain of
		// hops legible as arrivals rather than as a dot sliding about.
		const lit = new Map<number, number>();
		for (const pulse of pulses) {
			if (t < pulse.born) continue;
			const { u, leg, envelope } = pulseState(pulse, t);
			const brightness = envelope * pulse.gain;
			const edge = pulse.legEdges[leg]!;
			lit.set(edge, Math.max(lit.get(edge) ?? 0, brightness));

			while (pulse.leg < leg) {
				pulse.leg++;
				nodeGlow[pulse.seq[pulse.leg]!] = 1;
			}
			if (u >= 1) nodeGlow[pulse.seq.at(-1)!] = 1;
		}

		// Far to near, one blur per band. The blurred bands are drawn into an
		// offscreen canvas and composited in a single blurred `drawImage`, which
		// matters more than it sounds: setting `ctx.filter` and then stroking
		// each line individually makes the browser run a full-canvas filter pass
		// per line, and measured at 1700ms a frame. This way the blur costs two
		// composites.
		for (const [index, band] of BANDS.entries()) {
			const maxZ = index === 0 ? Infinity : BANDS[index - 1]!.minZ;

			if (band.blur === 0) {
				drawBand(ctx!, band.minZ, maxZ, points, lit, true);
				continue;
			}

			const layer = getLayer();
			if (!layer) {
				// No offscreen surface, so draw the band sharp rather than not at all.
				drawBand(ctx!, band.minZ, maxZ, points, lit, false);
				continue;
			}

			layer.clearRect(0, 0, width, height);
			drawBand(layer, band.minZ, maxZ, points, lit, false);

			ctx!.filter = `blur(${band.blur}px)`;
			ctx!.drawImage(layer.canvas, 0, 0, width, height);
			ctx!.filter = 'none';
		}

		ctx!.filter = 'none';

		/*
		 * The node the pointer is on: a soft dot blinking between white and the
		 * message colour, drawn crisp and at full brightness whatever depth it sits
		 * at. It is the one thing in the field the reader put there, so it does not
		 * get the depth treatment the rest of the field gets.
		 */
		if (hoverNode >= 0 && hoverEase > 0.01) {
			const p = points[hoverNode]!;
			const n = nodes[hoverNode]!;
			const blink = 0.5 + 0.5 * Math.sin((now / 1000) * BLINK_RATE);
			// The bright end of the blink is white on the dark field. On the pale one a
			// white dot on near-white paper is nothing at all, so it is warmed towards
			// the message colour in proportion to how light the field is.
			const bright = mixRgb(WHITE, palette.pulse, 0.5 * palette.light);
			const colour = mixRgb(bright, palette.pulse, blink);
			ctx!.shadowBlur = 9 * hoverEase;
			ctx!.shadowColor = withAlpha(palette.pulse, hoverEase);
			// Flat alpha: dimming the white half of the blink is what made it vanish.
			ctx!.fillStyle = withAlpha(colour, 0.95 * hoverEase);
			ctx!.beginPath();
			ctx!.arc(p.x, p.y, n.radius * (1 + 0.3 * hoverEase), 0, Math.PI * 2);
			ctx!.fill();
			ctx!.shadowBlur = 0;
			ctx!.shadowColor = 'transparent';
		}

		// The pulse heads go last and unblurred, so they stay crisp against the
		// field they are crossing.
		for (const pulse of pulses) {
			if (t < pulse.born) continue;
			const { leg, along, envelope } = pulseState(pulse, t);
			const from = points[pulse.seq[leg]!];
			const to = points[pulse.seq[leg + 1]!];
			if (!from || !to) continue;

			const x = from.x + (to.x - from.x) * along;
			const y = from.y + (to.y - from.y) * along;
			const bright = envelope * pulse.gain;

			ctx!.shadowBlur = 8;
			ctx!.shadowColor = withAlpha(palette.pulse, 0.55 * bright);
			ctx!.fillStyle = withAlpha(palette.pulse, 0.8 * bright);
			ctx!.beginPath();
			ctx!.arc(x, y, 1.7, 0, Math.PI * 2);
			ctx!.fill();
			ctx!.shadowBlur = 0;
			ctx!.shadowColor = 'transparent';
		}
	}

	function tick(now: number) {
		if (!running) return;
		frame = requestAnimationFrame(tick);
		// Full rate while the scroll offset is still catching up, or while a node is
		// held. Half rate for the idle drift.
		const busy =
			hoverNode >= 0 || Math.abs(scrollTarget - scrollEased) > 0.5 || Math.abs(scrollVel) > 1;
		if (now - lastDraw < 1000 / (busy ? ACTIVE_FPS : IDLE_FPS) - 1) return;
		lastDraw = now;
		draw(now);
	}

	function start() {
		if (running) return;
		running = true;
		// A static field still wants one frame, and one is all it gets.
		if (reduced.matches) {
			draw(0);
			running = false;
			return;
		}
		frame = requestAnimationFrame(tick);
	}

	function stop() {
		running = false;
		cancelAnimationFrame(frame);
	}

	// Scroll parallax is motion too, and it is the kind that provokes vestibular
	// symptoms, so a reader who asked for less gets a field that does not budge.
	const onScroll = () => {
		if (reduced.matches) return;
		scrollTarget = window.scrollY;
		// The ease only advances while the loop is drawing.
		if (!document.hidden) start();
	};

	// A page can open already scrolled, from an anchor or a restored position, and
	// that is a starting state rather than a scroll to glide towards.
	onScroll();
	scrollEased = scrollTarget;
	scrollVel = 0;
	resize();
	start();

	new ResizeObserver(() => {
		resize();
		if (reduced.matches) draw(0);
	}).observe(canvas);

	addEventListener('scroll', onScroll, { passive: true });

	/*
	 * Hover tracking. The canvas is `pointer-events: none` and sits at
	 * `z-index: -1`, so it cannot be hit-tested; the pointer is followed on the
	 * window instead. That is also the behaviour you want, since the field is
	 * behind the text and the reader is pointing at the page, not at the canvas.
	 */
	addEventListener(
		'pointermove',
		(e: PointerEvent) => {
			// Touch and pen would light a node up on tap and leave it lit, which is
			// not an interaction, just a mark.
			if (e.pointerType !== 'mouse' || reduced.matches) return;
			pointerX = e.clientX;
			pointerY = e.clientY;
			pointerSeen = true;
			// A pointer moving over a parked field should wake it, or the hover does
			// nothing until something else happens to redraw.
			if (!document.hidden) start();
		},
		{ passive: true }
	);

	// Let the node go when the pointer leaves the window or the page loses focus,
	// so nothing is left lit behind a switched tab.
	const releaseHover = () => {
		pointerSeen = false;
	};
	document.addEventListener('pointerleave', releaseHover);
	addEventListener('blur', releaseHover);

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stop();
		else start();
	});

	reduced.addEventListener('change', () => {
		scrollTarget = reduced.matches ? 0 : window.scrollY;
		scrollEased = scrollTarget;
		scrollVel = 0;
		stop();
		start();
	});

	// The palette lives in CSS custom properties, which change with the theme, so
	// re-read it and repaint. A parked field is left alone: it will read the new
	// colours from this variable whenever it next draws.
	new MutationObserver(() => {
		palette = readPalette();
		if (!document.hidden && (reduced.matches || !running)) draw(performance.now());
	}).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['data-theme'],
	});

	canvas.dataset.state = 'ready';
}

/** Parsed channels to an `rgba()` string. */
function withAlpha(rgb: Rgb, alpha: number): string {
	return `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${alpha})`;
}
