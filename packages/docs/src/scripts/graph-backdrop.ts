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
}

interface Palette {
	node: string;
	edge: string;
}

const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;

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
			edges.push({ a: i, b: j, strength: 1 - d / 0.62 });
		}
	}

	return { nodes, edges };
}

/** Read the two field colours from the stylesheet, so themes stay in one place. */
function readPalette(): Palette {
	const s = getComputedStyle(document.documentElement);
	return {
		node: s.getPropertyValue('--cw-graph-node').trim() || '#6cc2fb',
		edge: s.getPropertyValue('--cw-graph-edge').trim() || '#1487e0',
	};
}

export function initGraphBackdrop(canvas: HTMLCanvasElement) {
	const ctx = canvas.getContext('2d', { alpha: true });
	if (!ctx) return;

	const reduced = matchMedia('(prefers-reduced-motion: reduce)');

	let palette = readPalette();
	let nodes: Node[] = [];
	let edges: Edge[] = [];
	let width = 0;
	let height = 0;
	let dpr = 1;
	let frame = 0;
	let lastDraw = 0;
	let scrollY = 0;
	let running = false;

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

	function draw(now: number) {
		const t = reduced.matches ? 0 : now / 1000;
		ctx!.clearRect(0, 0, width, height);

		const points = nodes.map((n) => project(n, t));

		ctx!.lineWidth = 1;
		for (const e of edges) {
			const p = points[e.a]!;
			const q = points[e.b]!;
			const alpha = 0.17 * e.strength * ((p.fade + q.fade) / 2);
			ctx!.strokeStyle = withAlpha(palette.edge, alpha);
			ctx!.beginPath();
			ctx!.moveTo(p.x, p.y);
			ctx!.lineTo(q.x, q.y);
			ctx!.stroke();
		}

		for (const [i, n] of nodes.entries()) {
			const p = points[i]!;
			ctx!.fillStyle = withAlpha(palette.node, 0.36 * p.fade);
			ctx!.beginPath();
			ctx!.arc(p.x, p.y, n.radius, 0, Math.PI * 2);
			ctx!.fill();
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
	new MutationObserver(() => {
		palette = readPalette();
		if (reduced.matches) draw(0);
	}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

	canvas.dataset.state = 'ready';
}

/** Accepts the `#rrggbb` the stylesheet holds and returns an rgba() string. */
function withAlpha(hex: string, alpha: number): string {
	if (!hex.startsWith('#') || (hex.length !== 7 && hex.length !== 4)) {
		return hex;
	}
	const full =
		hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
	const r = parseInt(full.slice(1, 3), 16);
	const g = parseInt(full.slice(3, 5), 16);
	const b = parseInt(full.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
