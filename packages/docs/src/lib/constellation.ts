/**
 * Geometry for the node field, computed once at build time.
 *
 * This replaces what used to be two animation loops -- a 2D canvas behind every page and a WebGL
 * field behind the splash hero. Both looked good and both cost a core: a `requestAnimationFrame`
 * loop that redraws the whole viewport is doing work every 16ms whether or not anything about it
 * has changed, and a documentation site has no business doing that while someone reads.
 *
 * The shapes are the same shapes; only the machinery is different. Positions are decided here,
 * during the build, and the browser gets a static SVG with a handful of CSS animations on it. There
 * is no script, no canvas and no per-frame work on the main thread.
 *
 * Everything is derived from a fixed seed, so a given `Options` always produces the same field. A
 * layout that shifts on every deploy would make screenshot diffs useless and would mean the shape
 * of the page depended on the order the bundler happened to run in.
 */

export interface Node {
	x: number;
	y: number;
	/** 0 = far, 1 = near. Drives radius and brightness, standing in for the old depth fade. */
	depth: number;
	radius: number;
	/** Seconds. Only assigned to the subset that twinkles; 0 means "stays still". */
	twinkleDuration: number;
	twinkleDelay: number;
	layer: number;
}

export interface Edge {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	length: number;
	/** Mean depth of the endpoints, so a line at the back is fainter than one at the front. */
	depth: number;
	layer: number;
}

export interface Spark {
	edge: Edge;
	duration: number;
	delay: number;
}

export interface Field {
	width: number;
	height: number;
	layers: number[];
	nodes: Node[];
	edges: Edge[];
	sparks: Spark[];
}

export interface Options {
	seed: number;
	width: number;
	height: number;
	/** Target node count. The jittered grid lands near this rather than exactly on it. */
	count: number;
	/** Longest edge that may be drawn, in viewBox units. */
	reach: number;
	/** How many lines may leave one node. Keeps the field a constellation, not a mesh. */
	maxDegree: number;
	/** Number of edges that carry a travelling highlight. Deliberately small. */
	sparkCount: number;
	/** How many parallax groups to split the field across. */
	layers: number;
	/** Number of nodes that twinkle. The rest are static, which is most of them. */
	twinkleCount: number;
}

/** mulberry32. Small, fast, and good enough to scatter dots. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function buildField(options: Options): Field {
	const { seed, width, height, count, reach, maxDegree, sparkCount, layers, twinkleCount } =
		options;
	const random = rng(seed);

	// A jittered grid rather than uniform random placement. Pure randomness clumps, and clumps read
	// as a mistake in something that is supposed to look like a constellation.
	const aspect = width / height;
	const columns = Math.max(1, Math.round(Math.sqrt(count * aspect)));
	const rows = Math.max(1, Math.round(count / columns));
	const cellWidth = width / columns;
	const cellHeight = height / rows;

	const nodes: Node[] = [];
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			// Bleed past the edges so the field is cropped by the viewport rather than stopping
			// short of it with a visible margin.
			const x = (column + 0.15 + random() * 0.7) * cellWidth;
			const y = (row + 0.15 + random() * 0.7) * cellHeight;
			const depth = random();
			nodes.push({
				x: round(x),
				y: round(y),
				depth: round(depth),
				radius: round(1.5 + depth * 2.2),
				twinkleDuration: 0,
				twinkleDelay: 0,
				layer: Math.min(layers - 1, Math.floor(depth * layers)),
			});
		}
	}

	// Connect near neighbours only. Every pair is considered once, shortest first, so the field
	// fills in with the edges that look deliberate before any node reaches its degree limit.
	const candidates: { a: number; b: number; distance: number }[] = [];
	for (let a = 0; a < nodes.length; a++) {
		for (let b = a + 1; b < nodes.length; b++) {
			const distance = Math.hypot(nodes[a]!.x - nodes[b]!.x, nodes[a]!.y - nodes[b]!.y);
			if (distance <= reach) candidates.push({ a, b, distance });
		}
	}
	candidates.sort((p, q) => p.distance - q.distance);

	const degree = new Array(nodes.length).fill(0);
	const edges: Edge[] = [];
	for (const { a, b, distance } of candidates) {
		if (degree[a] >= maxDegree || degree[b] >= maxDegree) continue;
		degree[a]++;
		degree[b]++;
		const from = nodes[a]!;
		const to = nodes[b]!;
		edges.push({
			x1: from.x,
			y1: from.y,
			x2: to.x,
			y2: to.y,
			length: round(distance),
			depth: round((from.depth + to.depth) / 2),
			layer: from.layer,
		});
	}

	// Twinkling is the expensive part per element, so only a minority of nodes do it, and slowly.
	// The rest are static dots, which is what makes the whole thing affordable.
	const order = nodes.map((_, index) => index).sort(() => random() - 0.5);
	for (const index of order.slice(0, Math.min(twinkleCount, nodes.length))) {
		const node = nodes[index]!;
		node.twinkleDuration = round(4.5 + random() * 5.5);
		node.twinkleDelay = round(random() * 8);
	}

	// Sparks travel along the longer edges, where there is room to see them move, and are spread
	// across the field rather than clustered.
	const longest = [...edges].sort((p, q) => q.length - p.length);
	const stride = Math.max(1, Math.floor(longest.length / Math.max(1, sparkCount)));
	const sparks: Spark[] = [];
	for (let i = 0; i < longest.length && sparks.length < sparkCount; i += stride) {
		sparks.push({
			edge: longest[i]!,
			duration: round(3.2 + random() * 3.4),
			// Spread starts across a long window so they never march in step.
			delay: round(random() * 14),
		});
	}

	return {
		width,
		height,
		layers: Array.from({ length: layers }, (_, index) => index),
		nodes,
		edges,
		sparks,
	};
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
