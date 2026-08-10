/**
 * Geometry for the node field, computed once at build time.
 *
 * This replaces what used to be two animation loops -- a 2D canvas behind every page and a WebGL
 * field behind the splash hero. Both looked good and both cost a core: a `requestAnimationFrame`
 * loop that redraws the whole viewport is doing work every 16ms whether or not anything about it
 * has changed, and a documentation site has no business doing that while someone reads.
 *
 * The shapes are the same shapes; only the machinery is different. Positions are decided here,
 * during the build, and the browser gets static elements with a handful of CSS animations on them.
 * There is no script and no per-frame work on the main thread.
 *
 * Everything is derived from a fixed seed, so a given `Options` always produces the same field. A
 * layout that shifts on every deploy would make screenshot diffs useless and would mean the shape
 * of the page depended on the order the bundler happened to run in.
 *
 * ## The field is one connected graph, and has to be
 *
 * `buildField` guarantees a single connected component: every node is reachable from every other
 * node. Nearest-neighbour linking alone does not give you that. Capping edge length and node degree
 * is what keeps the field looking like a constellation instead of a mesh, and both caps strand
 * nodes -- an isolated dot here, a pair off in a corner there. So the greedy pass runs first for
 * looks, and then a second pass stitches whatever it left apart back together, shortest join first,
 * ignoring both caps because a connected field matters more than a uniform one.
 */

export interface Node {
	index: number;
	x: number;
	y: number;
	/** 0 = far, 1 = near. Drives radius and brightness, standing in for the old depth fade. */
	depth: number;
	radius: number;
	/** Seconds. Only assigned to the subset that twinkles; 0 means "stays still". */
	twinkleDuration: number;
	twinkleDelay: number;
}

export interface Edge {
	/** Endpoint node indices. The hover rules are generated from these. */
	a: number;
	b: number;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	length: number;
	/** Mean depth of the endpoints, so a line at the back is fainter than one at the front. */
	depth: number;
}

export interface Spark {
	edge: Edge;
	duration: number;
	delay: number;
}

export interface Field {
	width: number;
	height: number;
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
	/** Longest edge the greedy pass may draw, in authored units. Connection repair may exceed it. */
	reach: number;
	/** How many lines may leave one node. Keeps the field a constellation, not a mesh. */
	maxDegree: number;
	/** Number of edges that carry a travelling highlight. Deliberately small. */
	sparkCount: number;
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

/** Union-find over node indices, used to tell "already joined" from "still apart". */
function unionFind(size: number) {
	const parent = Array.from({ length: size }, (_, index) => index);
	const find = (x: number): number => {
		while (parent[x] !== x) {
			parent[x] = parent[parent[x]!]!;
			x = parent[x]!;
		}
		return x;
	};
	return {
		find,
		/** Joins two sets. Returns false if they were already the same set. */
		union(x: number, y: number): boolean {
			const rootX = find(x);
			const rootY = find(y);
			if (rootX === rootY) return false;
			parent[rootX] = rootY;
			return true;
		},
	};
}

export function buildField(options: Options): Field {
	const { seed, width, height, count, reach, maxDegree, sparkCount, twinkleCount } = options;
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
				index: nodes.length,
				x: round(x),
				y: round(y),
				depth: round(depth),
				radius: round(1.5 + depth * 2.2),
				twinkleDuration: 0,
				twinkleDelay: 0,
			});
		}
	}

	// Every pair, once, shortest first. The field is small enough that considering all of them is
	// cheaper than the machinery to avoid it, and both passes below want the same sorted list.
	const pairs: { a: number; b: number; distance: number }[] = [];
	for (let a = 0; a < nodes.length; a++) {
		for (let b = a + 1; b < nodes.length; b++) {
			pairs.push({
				a,
				b,
				distance: Math.hypot(nodes[a]!.x - nodes[b]!.x, nodes[a]!.y - nodes[b]!.y),
			});
		}
	}
	pairs.sort((p, q) => p.distance - q.distance);

	const components = unionFind(nodes.length);
	const degree: number[] = new Array(nodes.length).fill(0);
	const joins: { a: number; b: number }[] = [];

	// Pass one, for looks: near neighbours only, shortest first, so the field fills in with the
	// edges that look deliberate before any node reaches its degree limit.
	for (const { a, b, distance } of pairs) {
		if (distance > reach) break;
		if (degree[a]! >= maxDegree || degree[b]! >= maxDegree) continue;
		degree[a]!++;
		degree[b]!++;
		components.union(a, b);
		joins.push({ a, b });
	}

	// Pass two, for correctness: Kruskal over the same sorted list, adding only the edges that
	// join two pieces that are still apart. Neither cap applies here -- an over-long line or a
	// fourth line out of one node is a smaller flaw than a dot sitting on its own with nothing
	// attached to it. In practice this adds a handful of edges.
	for (const { a, b } of pairs) {
		if (components.union(a, b)) {
			degree[a]!++;
			degree[b]!++;
			joins.push({ a, b });
		}
	}

	// Positions come from the nodes rather than being carried along, so an edge can never disagree
	// with the dots it is supposed to be touching.
	const edges: Edge[] = joins.map(({ a, b }) => {
		const from = nodes[a]!;
		const to = nodes[b]!;
		return {
			a,
			b,
			x1: from.x,
			y1: from.y,
			x2: to.x,
			y2: to.y,
			length: round(Math.hypot(to.x - from.x, to.y - from.y)),
			depth: round((from.depth + to.depth) / 2),
		};
	});

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

	return { width, height, nodes, edges, sparks };
}

/**
 * Number of connected components in a field. One means every node is reachable from every other.
 * Exported for the build-time assertion in the component, which is the only thing standing between
 * a bad tuning change and a field with a dot floating on its own in it.
 */
export function componentCount(field: Field): number {
	const components = unionFind(field.nodes.length);
	let count = field.nodes.length;
	for (const edge of field.edges) {
		if (components.union(edge.a, edge.b)) count--;
	}
	return count;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
