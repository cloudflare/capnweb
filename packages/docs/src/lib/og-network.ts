/**
 * The frozen-network motif used as the backdrop of every social card.
 *
 * This is the same idea as the WebGL hero in `src/scripts/network-hero.ts` --
 * nodes on a sphere, wired to their nearest neighbours, with a few pulses
 * travelling the edges -- but flattened to a still SVG that a build step can
 * rasterize. Deliberately a separate, much smaller implementation: the hero
 * needs GPU buffers and a frame loop, and this needs a string.
 *
 * Everything here is seeded, so a given page's card is identical on every
 * build, and two different pages get two different networks.
 */

/** Deterministic PRNG. Same one the hero uses, for the same reason. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Turn any string into a stable 32-bit seed, so the slug picks the network. */
export function seedFrom(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

interface Node {
	x: number;
	y: number;
	/** Depth in [0,1]. Drives size and opacity so the sphere reads as 3D. */
	z: number;
}

export interface NetworkOptions {
	width: number;
	height: number;
	seed: number;
	/** How many nodes. The hero uses 190; a still can carry fewer. */
	count?: number;
	/** Edges per node, to its nearest neighbours. */
	degree?: number;
}

/**
 * Nodes on a jittered Fibonacci sphere, rotated, then projected. The jitter is
 * what stops it reading as a lattice; the rotation is what stops every card
 * having its pole in the same place.
 */
function buildNodes(rand: () => number, count: number, radius: number): Node[] {
	const golden = Math.PI * (3 - Math.sqrt(5));
	const yaw = rand() * Math.PI * 2;
	const pitch = (rand() - 0.5) * 1.1;
	const cy = Math.cos(yaw);
	const sy = Math.sin(yaw);
	const cp = Math.cos(pitch);
	const sp = Math.sin(pitch);

	const nodes: Node[] = [];
	for (let i = 0; i < count; i++) {
		const t = 1 - (2 * i + 1) / count;
		const r = Math.sqrt(Math.max(0, 1 - t * t));
		const theta = golden * i + (rand() - 0.5) * 0.35;

		// Unit sphere, jittered outward slightly so the shell has thickness.
		const shell = radius * (0.86 + rand() * 0.14);
		let x = Math.cos(theta) * r * shell;
		let y = t * shell;
		let z = Math.sin(theta) * r * shell;

		// Yaw then pitch.
		[x, z] = [x * cy - z * sy, x * sy + z * cy];
		[y, z] = [y * cp - z * sp, y * sp + z * cp];

		nodes.push({ x, y, z: (z / radius + 1) / 2 });
	}
	return nodes;
}

/** Index pairs for each node's nearest neighbours, deduplicated. */
function buildEdges(nodes: Node[], degree: number): [number, number][] {
	const seen = new Set<string>();
	const edges: [number, number][] = [];

	for (let i = 0; i < nodes.length; i++) {
		const distances = nodes
			.map((other, j) => ({ j, d: (other.x - nodes[i]!.x) ** 2 + (other.y - nodes[i]!.y) ** 2 }))
			.filter((entry) => entry.j !== i)
			.sort((a, b) => a.d - b.d)
			.slice(0, degree);

		for (const { j } of distances) {
			const key = i < j ? `${i}:${j}` : `${j}:${i}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push([i, j]);
		}
	}
	return edges;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * The backdrop, as a standalone SVG document.
 *
 * Returned as a string rather than a file because the only consumer embeds it
 * as a data URI. Colours are hard-coded rather than read from `theme.css`:
 * this runs in Node at build time with no stylesheet in scope, and a social
 * card is always dark regardless of the reader's colour scheme.
 */
export function networkSvg(options: NetworkOptions): string {
	const { width, height, seed, count = 96, degree = 3 } = options;
	const rand = mulberry32(seed);

	// Off to the right, partly cropped: the text block owns the left half, and
	// a sphere running off the edge reads as bigger than the frame.
	const cx = width * 0.78;
	const cy = height * 0.46;
	const radius = Math.min(width, height) * 0.62;

	const nodes = buildNodes(rand, count, radius);
	const edges = buildEdges(nodes, degree);

	// A handful of edges get the accent, standing in for pulses in flight. The
	// same discipline as the rest of the site: orange means "a call is
	// happening", and nothing else.
	//
	// Chosen from the near face and from well inside the frame, because a
	// highlight cropped by the edge of the card just reads as a stray mark.
	const inFrame = (n: Node) =>
		cx + n.x > width * 0.5 && cx + n.x < width - 40 && cy + n.y > 40 && cy + n.y < height - 40;

	const candidates = edges
		.map((edge, index) => ({ index, edge, depth: (nodes[edge[0]]!.z + nodes[edge[1]]!.z) / 2 }))
		.filter(({ edge }) => inFrame(nodes[edge[0]]!) && inFrame(nodes[edge[1]]!))
		.sort((a, b) => b.depth - a.depth)
		.slice(0, Math.max(6, Math.floor(edges.length * 0.25)));

	const hot = new Set<number>();
	while (hot.size < Math.min(3, candidates.length)) {
		hot.add(candidates[Math.floor(rand() * candidates.length)]!.index);
	}

	const parts: string[] = [];

	parts.push(
		`<defs>` +
			`<radialGradient id="bg" cx="74%" cy="40%" r="82%">` +
			`<stop offset="0%" stop-color="#0e2a4d"/>` +
			`<stop offset="55%" stop-color="#071426"/>` +
			`<stop offset="100%" stop-color="#04070e"/>` +
			`</radialGradient>` +
			`<radialGradient id="glow" cx="50%" cy="50%" r="50%">` +
			`<stop offset="0%" stop-color="#1487e0" stop-opacity="0.30"/>` +
			`<stop offset="100%" stop-color="#1487e0" stop-opacity="0"/>` +
			`</radialGradient>` +
			`</defs>`,
	);

	parts.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/>`);
	parts.push(
		`<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(radius * 1.15)}" fill="url(#glow)"/>`,
	);

	// Edges first, so nodes sit on top of them.
	edges.forEach(([a, b], index) => {
		const from = nodes[a]!;
		const to = nodes[b]!;
		const depth = (from.z + to.z) / 2;
		const accent = hot.has(index);
		const opacity = accent ? 0.55 + depth * 0.35 : 0.06 + depth * 0.26;
		parts.push(
			`<line x1="${round(cx + from.x)}" y1="${round(cy + from.y)}"` +
				` x2="${round(cx + to.x)}" y2="${round(cy + to.y)}"` +
				` stroke="${accent ? '#f6821f' : '#1487e0'}"` +
				` stroke-width="${accent ? 1.6 : 1}" stroke-opacity="${round(opacity)}"/>`,
		);
	});

	nodes.forEach((node, index) => {
		// Endpoints of an accent edge are lit too, so the highlight has anchors.
		const accent = edges.some(([a, b], i) => hot.has(i) && (a === index || b === index));
		const r = 1.1 + node.z * 2.5;
		parts.push(
			`<circle cx="${round(cx + node.x)}" cy="${round(cy + node.y)}" r="${round(r)}"` +
				` fill="${accent ? '#f6821f' : '#4db4ff'}"` +
				` fill-opacity="${round(accent ? 0.95 : 0.25 + node.z * 0.6)}"/>`,
		);
	});

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
		`viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
	);
}
