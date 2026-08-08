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

import { themeFadeMs } from './theme-fade';

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

/** A message travelling out along an edge and back again. */
interface Pulse {
	edge: number;
	/** Field time at which it left, and how long the full round trip takes. */
	born: number;
	duration: number;
}

type Rgb = [number, number, number];

interface Palette {
	node: Rgb;
	edge: Rgb;
	pulse: Rgb;
	edgeAlpha: number;
}

const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;

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

/** Round trips are an occasional event, not a light show. */
const MAX_PULSES = 2;
const PULSE_GAP_MIN = 6;
const PULSE_GAP_MAX = 15;

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

function buildField(count: number, seed: number): { nodes: Node[]; edges: Edge[] } {
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

	return { nodes, edges };
}

/** Read the field colours from the stylesheet, so themes stay in one place. */
function readPalette(): Palette {
	const s = getComputedStyle(document.documentElement);
	return {
		node: parseHex(s.getPropertyValue('--cw-graph-node'), [108, 194, 251]),
		edge: parseHex(s.getPropertyValue('--cw-graph-edge'), [20, 135, 224]),
		pulse: parseHex(s.getPropertyValue('--cw-graph-pulse'), [201, 120, 46]),
		edgeAlpha: Number(s.getPropertyValue('--cw-graph-edge-alpha')) || 0.17,
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

function mixPalette(a: Palette, b: Palette, u: number): Palette {
	const mix = (x: Rgb, y: Rgb): Rgb => [
		mixChannel(x[0], y[0], u),
		mixChannel(x[1], y[1], u),
		mixChannel(x[2], y[2], u),
	];
	return {
		node: mix(a.node, b.node),
		edge: mix(a.edge, b.edge),
		pulse: mix(a.pulse, b.pulse),
		edgeAlpha: mixChannel(a.edgeAlpha, b.edgeAlpha, u),
	};
}

export function initGraphBackdrop(canvas: HTMLCanvasElement) {
	const ctx = canvas.getContext('2d', { alpha: true });
	if (!ctx) return;

	const reduced = matchMedia('(prefers-reduced-motion: reduce)');

	// The theme cross-fade. CSS cannot transition what a canvas paints, so the
	// palette is tweened here over the same duration the stylesheet uses, and the
	// two arrive together.
	let paletteFrom = readPalette();
	let paletteTo = paletteFrom;
	let palette = paletteFrom;
	let fadeStart = 0;
	let fadeMs = 0;
	let nodes: Node[] = [];
	let edges: Edge[] = [];
	let width = 0;
	let height = 0;
	let dpr = 1;
	let frame = 0;
	let lastDraw = 0;
	let scrollY = 0;
	let running = false;
	let layer: CanvasRenderingContext2D | null = null;
	const pulses: Pulse[] = [];
	const pulseRand = mulberry32(0xc0ffee);
	let nextPulseAt = PULSE_GAP_MIN;

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
		if (count !== nodes.length) ({ nodes, edges } = buildField(count, 0x5eed));
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
			y: height / 2 + (n.y + wobbleY) * height * 0.62 * spread - scrollY * parallax,
			// Same depth cue applied to size and opacity.
			fade: 0.35 + (1 - n.z) * 0.65,
		};
	}

	/**
	 * Retire finished pulses and occasionally start a new one. Edges are picked
	 * from the near half of the field, since a round trip is the one thing here
	 * worth noticing and the far layers are out of focus.
	 */
	function updatePulses(t: number) {
		for (let i = pulses.length - 1; i >= 0; i--) {
			if (t - pulses[i]!.born > pulses[i]!.duration) pulses.splice(i, 1);
		}

		if (t < nextPulseAt || pulses.length >= MAX_PULSES || edges.length === 0) return;

		let edge = Math.floor(pulseRand() * edges.length);
		for (let attempt = 0; attempt < 6 && edges[edge]!.midZ > 0.55; attempt++) {
			edge = Math.floor(pulseRand() * edges.length);
		}

		pulses.push({ edge, born: t, duration: 1.6 + pulseRand() * 1.4 });
		nextPulseAt = t + PULSE_GAP_MIN + pulseRand() * (PULSE_GAP_MAX - PULSE_GAP_MIN);
	}

	/** Position and brightness of a pulse: out to the far node, then back. */
	function pulseState(pulse: Pulse, t: number) {
		const u = Math.min(1, Math.max(0, (t - pulse.born) / pulse.duration));
		// A triangle wave, so the head reaches the far node at the halfway point
		// and is home again at the end.
		const along = u < 0.5 ? u * 2 : (1 - u) * 2;
		// Ramped at both ends so it departs and arrives rather than popping in.
		const envelope = Math.min(1, u / 0.12, (1 - u) / 0.12);
		return { along, envelope };
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
			target.strokeStyle =
				brightness > 0
					? withAlpha(palette.pulse, 0.22 * brightness * depth)
					: withAlpha(palette.edge, palette.edgeAlpha * e.strength * depth);
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
			const p = points[i]!;
			target.fillStyle = withAlpha(palette.node, 0.36 * p.fade);
			target.beginPath();
			target.arc(p.x, p.y, n.radius, 0, Math.PI * 2);
			target.fill();
		}

		target.shadowBlur = 0;
		target.shadowColor = 'transparent';
	}

	/** Advance the theme cross-fade, if one is running. */
	function updatePalette(now: number) {
		if (fadeMs <= 0) {
			palette = paletteTo;
			return;
		}
		const u = Math.min(1, (now - fadeStart) / fadeMs);
		palette = u >= 1 ? paletteTo : mixPalette(paletteFrom, paletteTo, u);
		if (u >= 1) fadeMs = 0;
	}

	function draw(now: number) {
		const t = reduced.matches ? 0 : (now / 1000) * TIME_SCALE;
		updatePalette(now);
		ctx!.clearRect(0, 0, width, height);

		const points = nodes.map((n) => project(n, t));
		if (!reduced.matches) updatePulses(t);

		// Which edges are currently lit, and how brightly. Looked up per edge
		// while drawing, so a pulse can colour the line it is travelling along.
		const lit = new Map<number, number>();
		for (const pulse of pulses) {
			const { envelope } = pulseState(pulse, t);
			lit.set(pulse.edge, Math.max(lit.get(pulse.edge) ?? 0, envelope));
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

		// The pulse heads go last and unblurred, so they stay crisp against the
		// field they are crossing.
		for (const pulse of pulses) {
			const e = edges[pulse.edge];
			if (!e) continue;
			const p = points[e.a]!;
			const q = points[e.b]!;
			const { along, envelope } = pulseState(pulse, t);
			const x = p.x + (q.x - p.x) * along;
			const y = p.y + (q.y - p.y) * along;

			ctx!.shadowBlur = 8;
			ctx!.shadowColor = withAlpha(palette.pulse, 0.55 * envelope);
			ctx!.fillStyle = withAlpha(palette.pulse, 0.8 * envelope);
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
		if (now - lastDraw < FRAME_MS) return;
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
		scrollY = window.scrollY;
	};

	// A page can open already scrolled, from an anchor or a restored position.
	onScroll();
	resize();
	start();

	new ResizeObserver(() => {
		resize();
		if (reduced.matches) draw(0);
	}).observe(canvas);

	addEventListener('scroll', onScroll, { passive: true });

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stop();
		else start();
	});

	reduced.addEventListener('change', () => {
		scrollY = reduced.matches ? 0 : window.scrollY;
		stop();
		start();
	});

	// The palette lives in CSS custom properties, which change with the theme.
	// Fade from wherever the tween currently is, so toggling twice quickly picks up
	// from what is on screen rather than snapping back to the previous scheme.
	new MutationObserver(() => {
		const next = readPalette();
		if (reduced.matches) {
			// Everything else snaps for this reader too. See the theme-transition
			// block in theme.css.
			paletteFrom = next;
			paletteTo = next;
			palette = next;
			fadeMs = 0;
			draw(0);
			return;
		}

		paletteFrom = palette;
		paletteTo = next;
		fadeStart = performance.now();
		fadeMs = themeFadeMs();
		// The field is parked while the tab is hidden, and a fade nobody can see
		// does not need to run. It will be drawn with the final palette on return.
		if (!document.hidden) start();
	}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

	canvas.dataset.state = 'ready';
}

/** Parsed channels to an `rgba()` string. */
function withAlpha(rgb: Rgb, alpha: number): string {
	return `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${alpha})`;
}
