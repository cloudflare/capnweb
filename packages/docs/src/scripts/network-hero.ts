/**
 * The landing page hero: a rotating 3D network with round trips running on it.
 *
 * Raw WebGL2, no dependency. The whole point of the page it sits on is that
 * Cap'n Web is under 10 kB with nothing behind it, so shipping a 3D framework
 * to draw points and lines would undercut the claim in the headline.
 *
 * What it draws, back to front:
 *   1. a full-screen gradient (in the shader, not CSS, so the canvas is opaque
 *      and additive blending has a known backdrop)
 *   2. edges, brightening as traffic crosses them and decaying after
 *   3. nodes, with a slow individual twinkle
 *   4. pulses -- the orange sparks
 *
 * The pulses are the argument, not decoration. Each one leaves a node, runs
 * outward across several hops, and comes back along the same path: the whole
 * dependent chain, one trip. That is what promise pipelining buys you, so the
 * hero shows it rather than asserting it.
 */

/* ------------------------------------------------------------------ types */

interface Palette {
	/**
	 * 1 on the light scheme, 0 on the dark one. A number rather than a boolean
	 * because several of the strengths below are scaled by it.
	 *
	 * Light mode is not a recolour of the same drawing. Additive blending can only
	 * ever add light, so on a near-white page it does nothing, and the network has
	 * to be composited normally, as dark ink, instead; see `frame()`.
	 */
	light: number;
	bgInner: [number, number, number];
	bgOuter: [number, number, number];
	node: [number, number, number];
	edge: [number, number, number];
	pulse: [number, number, number];
}

interface Pulse {
	/** Node indices: outward leg. The return leg is this reversed. */
	path: number[];
	/** Index of the hop currently being crossed. */
	hop: number;
	/** 0..1 along the current hop. */
	t: number;
	/** Hops per second. */
	speed: number;
	returning: boolean;
	/** Seconds to wait before setting off again. */
	wait: number;
	/** Hover traffic is retired when it gets home; ambient traffic recycles. */
	oneShot?: boolean;
}

/* ------------------------------------------------------------- tiny maths */

type Mat4 = Float32Array;

function mat4(): Mat4 {
	const m = new Float32Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	return m;
}

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
	const f = 1 / Math.tan(fovy / 2);
	const m = new Float32Array(16);
	m[0] = f / aspect;
	m[5] = f;
	m[10] = (far + near) / (near - far);
	m[11] = -1;
	m[14] = (2 * far * near) / (near - far);
	return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
	const o = new Float32Array(16);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			o[c * 4 + r] =
				a[r]! * b[c * 4]! +
				a[4 + r]! * b[c * 4 + 1]! +
				a[8 + r]! * b[c * 4 + 2]! +
				a[12 + r]! * b[c * 4 + 3]!;
		}
	}
	return o;
}

/** Camera at `eye` looking at the origin, with +Y up. */
function lookAtOrigin(ex: number, ey: number, ez: number): Mat4 {
	let zx = ex,
		zy = ey,
		zz = ez;
	let l = Math.hypot(zx, zy, zz) || 1;
	zx /= l;
	zy /= l;
	zz /= l;
	// x = normalize(cross(up, z)), with up = (0, 1, 0)
	let xx = zz,
		xy = 0,
		xz = -zx;
	l = Math.hypot(xx, xy, xz) || 1;
	xx /= l;
	xy /= l;
	xz /= l;
	// y = cross(z, x)
	const yx = zy * xz - zz * xy;
	const yy = zz * xx - zx * xz;
	const yz = zx * xy - zy * xx;

	const m = new Float32Array(16);
	m[0] = xx;
	m[1] = yx;
	m[2] = zx;
	m[4] = xy;
	m[5] = yy;
	m[6] = zy;
	m[8] = xz;
	m[9] = yz;
	m[10] = zz;
	m[12] = -(xx * ex + xy * ey + xz * ez);
	m[13] = -(yx * ex + yy * ey + yz * ez);
	m[14] = -(zx * ex + zy * ey + zz * ez);
	m[15] = 1;
	return m;
}

function rotationY(a: number): Mat4 {
	const m = mat4();
	const c = Math.cos(a),
		s = Math.sin(a);
	m[0] = c;
	m[2] = -s;
	m[8] = s;
	m[10] = c;
	return m;
}

function rotationX(a: number): Mat4 {
	const m = mat4();
	const c = Math.cos(a),
		s = Math.sin(a);
	m[5] = c;
	m[6] = s;
	m[9] = -s;
	m[10] = c;
	return m;
}

/* ----------------------------------------------------------- the network */

const NODE_COUNT = 190;
const NEIGHBOURS = 3;
/*
 * Spontaneous traffic: a message out to one neighbour and straight back, the
 * same single-edge bounce the 2D backdrop uses. A multi-hop walk out and back
 * turned out to read as a wandering dot rather than as a round trip, and the
 * round trip is the entire argument this drawing is making.
 *
 * Deliberately sparse. Three in flight at most, resting for seconds between
 * trips, which works out at about a fifth of the traffic there used to be: a
 * signal every 1.4s or so against four a second. The reader provokes the rest by
 * pointing at a node.
 */
const PULSE_COUNT = 3;
const AMBIENT_REST_MIN = 2.4;
const AMBIENT_REST_SPAN = 2.2;
const SPHERE_R = 1.32;

/*
 * Hover. Same idea as the 2D backdrop: put the pointer near a node and that
 * node talks to its neighbours. Here the nodes are on a sphere, so the pick has
 * to happen in screen space after projection, and a node on the far side of the
 * sphere must not win over the one in front of it.
 *
 * Radii are CSS pixels, scaled by the device ratio at the point of use.
 */
const HOVER_RADIUS = 70;
const HOVER_RELEASE = 120;
const HOVER_HANDOVER = 18;
/** Pixels of penalty per world unit of camera distance. The sphere is ~3 across. */
const HOVER_DEPTH_PENALTY = 24;
const HOVER_WAVE_GAP = 1.1;
const HOVER_STAGGER = 0.07;
const HOVER_SECOND_HOP_CHANCE = 0.35;
/** A node has three or four neighbours, and two waves can overlap. */
const HOVER_PULSE_MAX = 10;
/** Radians per second of the hover blink. The backdrop uses the same number. */
const BLINK_RATE = 5.7;

interface Graph {
	positions: Float32Array;
	seeds: Float32Array;
	edges: Uint16Array;
	adjacency: number[][];
}

/**
 * Nodes on a Fibonacci sphere, jittered off the shell so the result reads as a
 * volume rather than a wireframe ball, then each joined to its nearest few
 * neighbours. Deterministic: the same hero every load, so a visual regression
 * is a real change and not the random seed.
 */
function buildGraph(): Graph {
	const positions = new Float32Array(NODE_COUNT * 3);
	const seeds = new Float32Array(NODE_COUNT);
	const golden = Math.PI * (3 - Math.sqrt(5));

	// Cheap deterministic PRNG (mulberry32).
	let state = 0x9e3779b9;
	const rand = () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	for (let i = 0; i < NODE_COUNT; i++) {
		const y = 1 - (i / (NODE_COUNT - 1)) * 2;
		const radius = Math.sqrt(Math.max(0, 1 - y * y));
		const theta = golden * i;
		const shell = SPHERE_R * (0.82 + rand() * 0.28);
		positions[i * 3] = Math.cos(theta) * radius * shell;
		positions[i * 3 + 1] = y * shell;
		positions[i * 3 + 2] = Math.sin(theta) * radius * shell;
		seeds[i] = rand();
	}

	// Nearest neighbours. NODE_COUNT is small enough that the naive O(n^2)
	// pass is well under a millisecond and runs exactly once.
	const adjacency: number[][] = Array.from({ length: NODE_COUNT }, () => []);
	const pairs = new Set<number>();
	const edgeList: number[] = [];

	for (let i = 0; i < NODE_COUNT; i++) {
		const best: { j: number; d: number }[] = [];
		for (let j = 0; j < NODE_COUNT; j++) {
			if (i === j) continue;
			const dx = positions[i * 3]! - positions[j * 3]!;
			const dy = positions[i * 3 + 1]! - positions[j * 3 + 1]!;
			const dz = positions[i * 3 + 2]! - positions[j * 3 + 2]!;
			const d = dx * dx + dy * dy + dz * dz;
			if (best.length < NEIGHBOURS) {
				best.push({ j, d });
				best.sort((a, b) => a.d - b.d);
			} else if (d < best[best.length - 1]!.d) {
				best[best.length - 1] = { j, d };
				best.sort((a, b) => a.d - b.d);
			}
		}
		for (const { j } of best) {
			const key = i < j ? i * NODE_COUNT + j : j * NODE_COUNT + i;
			if (pairs.has(key)) continue;
			pairs.add(key);
			edgeList.push(i, j);
			adjacency[i]!.push(j);
			adjacency[j]!.push(i);
		}
	}

	return { positions, seeds, edges: new Uint16Array(edgeList), adjacency };
}

/* --------------------------------------------------------------- shaders */

const BG_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const BG_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec3 u_inner;
uniform vec3 u_outer;
uniform float u_aspect;
out vec4 fragColor;
void main() {
  // Off-centre glow, sitting behind where the network sits.
  vec2 p = (v_uv - vec2(0.62, 0.52)) * vec2(u_aspect, 1.0);
  float d = length(p) * 1.15;
  float g = exp(-d * d * 1.9);
  vec3 c = mix(u_outer, u_inner, g);
  // A hint of banding-free dither; flat gradients on near-black band badly.
  float n = fract(sin(dot(v_uv, vec2(12.9898, 78.233))) * 43758.5453);
  fragColor = vec4(c + (n - 0.5) / 255.0, 1.0);
}`;

const NODE_VS = `#version 300 es
in vec3 a_pos;
in float a_seed;
in float a_flash;
uniform mat4 u_mvp;
uniform float u_time;
uniform float u_scale;
uniform int u_hover;
uniform float u_hoverEase;
out float v_fade;
out float v_flash;
out float v_hover;
void main() {
  vec4 clip = u_mvp * vec4(a_pos, 1.0);
  gl_Position = clip;
  float twinkle = 0.72 + 0.28 * sin(u_time * 0.9 + a_seed * 6.2831853);
  // Fade with distance so the far half of the sphere recedes.
  v_fade = clamp((5.6 - clip.w) / 3.2, 0.05, 1.0) * twinkle;
  v_flash = a_flash;
  v_hover = (gl_VertexID == u_hover) ? u_hoverEase : 0.0;
  gl_PointSize = u_scale * (1.0 + a_flash * 1.7 + v_hover * 2.2) / max(clip.w, 0.2);
}`;

const NODE_FS = `#version 300 es
precision highp float;
in float v_fade;
in float v_flash;
in float v_hover;
uniform vec3 u_color;
uniform vec3 u_flashColor;
uniform vec3 u_hoverColor;
uniform float u_hot;
out vec4 fragColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = pow(1.0 - r, 1.9);
  // A tight white centre inside the softer disc, so a node reads as a light
  // source rather than a dot. Additive only; in light mode u_hot is 0 and the
  // node is flat ink instead.
  float hot = pow(1.0 - r, 9.0) * u_hot;
  vec3 c = mix(u_color, u_flashColor, clamp(v_flash, 0.0, 1.0)) + vec3(hot * 0.7);
  // The held node is not one of the crowd: it blinks between white and the
  // message colour, and takes that over whatever the flash left behind.
  float held = clamp(v_hover, 0.0, 1.0);
  c = mix(c, u_hoverColor, held);
  // The held node is the one thing here the reader put on screen, so it is exempt
  // from the depth fade and the twinkle that keep the other 189 in their place.
  float a = core * max(v_fade, held * 0.92) * (1.0 + held * 1.2);
  fragColor = vec4(c * a, a);
}`;

const EDGE_VS = `#version 300 es
in vec3 a_pos;
in float a_glow;
uniform mat4 u_mvp;
out float v_fade;
out float v_glow;
void main() {
  vec4 clip = u_mvp * vec4(a_pos, 1.0);
  gl_Position = clip;
  v_fade = clamp((5.6 - clip.w) / 3.2, 0.0, 1.0);
  v_glow = a_glow;
}`;

const EDGE_FS = `#version 300 es
precision highp float;
in float v_fade;
in float v_glow;
uniform vec3 u_color;
uniform vec3 u_hotColor;
uniform float u_base;
out vec4 fragColor;
void main() {
  vec3 c = mix(u_color, u_hotColor, clamp(v_glow, 0.0, 1.0));
  float a = (u_base + v_glow * 0.85) * v_fade;
  fragColor = vec4(c * a, a);
}`;

const PULSE_VS = `#version 300 es
in vec3 a_pos;
uniform mat4 u_mvp;
uniform float u_scale;
out float v_fade;
void main() {
  vec4 clip = u_mvp * vec4(a_pos, 1.0);
  gl_Position = clip;
  v_fade = clamp((5.6 - clip.w) / 3.2, 0.08, 1.0);
  gl_PointSize = u_scale / max(clip.w, 0.2);
}`;

const PULSE_FS = `#version 300 es
precision highp float;
in float v_fade;
uniform vec3 u_color;
uniform float u_hot;
out vec4 fragColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = pow(1.0 - r, 1.5);
  float hot = pow(1.0 - r, 7.0) * u_hot;
  vec3 c = u_color + vec3(hot * 0.85);
  float a = core * v_fade;
  fragColor = vec4(c * a, a);
}`;

/* ----------------------------------------------------------- gl plumbing */

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
	const sh = gl.createShader(type);
	if (!sh) return null;
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		gl.deleteShader(sh);
		return null;
	}
	return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
	const v = compile(gl, gl.VERTEX_SHADER, vs);
	const f = compile(gl, gl.FRAGMENT_SHADER, fs);
	if (!v || !f) return null;
	const p = gl.createProgram();
	if (!p) return null;
	gl.attachShader(p, v);
	gl.attachShader(p, f);
	gl.linkProgram(p);
	gl.deleteShader(v);
	gl.deleteShader(f);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
		gl.deleteProgram(p);
		return null;
	}
	return p;
}

/** Normalised white, the bright end of the hover blink. */
const WHITE: [number, number, number] = [1, 1, 1];

/** Channelwise blend of two colours. Components are 0 to 1, as the shaders want. */
function mixRgb(
	a: [number, number, number],
	b: [number, number, number],
	u: number
): [number, number, number] {
	return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

function readPalette(root: HTMLElement): Palette {
	const cs = getComputedStyle(root);
	const parse = (name: string, fallback: [number, number, number]): [number, number, number] => {
		const raw = cs.getPropertyValue(name).trim();
		const m = /^#([0-9a-f]{6})$/i.exec(raw);
		if (!m) return fallback;
		const n = parseInt(m[1]!, 16);
		return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
	};
	return {
		light: root.dataset.theme === 'light' ? 1 : 0,
		bgInner: parse('--cw-hero-bg-inner', [0.027, 0.125, 0.255]),
		bgOuter: parse('--cw-hero-bg-outer', [0.016, 0.027, 0.055]),
		node: parse('--cw-hero-node', [0.424, 0.761, 0.984]),
		edge: parse('--cw-hero-edge', [0.078, 0.529, 0.878]),
		pulse: parse('--cw-hero-pulse', [0.965, 0.51, 0.122]),
	};
}

/* -------------------------------------------------------------- the hero */

/**
 * Every GPU-side object. All of it dies with the drawing context, so it lives
 * in one struct that can be dropped and rebuilt as a unit when the context is
 * lost and restored -- which really does happen on real machines, on GPU
 * driver resets and on wake from sleep. The simulation state is deliberately
 * kept outside, so a restore resumes the animation instead of restarting it.
 */
interface Gpu {
	bgProg: WebGLProgram;
	nodeProg: WebGLProgram;
	edgeProg: WebGLProgram;
	pulseProg: WebGLProgram;
	quadBuf: WebGLBuffer;
	nodePosBuf: WebGLBuffer;
	nodeSeedBuf: WebGLBuffer;
	nodeFlashBuf: WebGLBuffer;
	edgePosBuf: WebGLBuffer;
	edgeGlowBuf: WebGLBuffer;
	pulseBuf: WebGLBuffer;
}

export function initNetworkHero(canvas: HTMLCanvasElement): () => void {
	const ctx = canvas.getContext('webgl2', {
		alpha: false,
		antialias: true,
		depth: false,
	});

	// No WebGL2: leave the CSS fallback gradient visible and do nothing else.
	if (!ctx) {
		canvas.dataset.state = 'unsupported';
		return () => {};
	}

	// Aliased through an explicitly typed binding: the render loop closes over
	// this, and narrowing from the check above does not survive into every
	// nested function.
	const gl: WebGL2RenderingContext = ctx;

	/* ------------------------------------------------------- cpu-side state */

	const graph = buildGraph();
	const edgeCount = graph.edges.length / 2;

	// Edge vertex positions are static: two endpoints per edge, expanded here so
	// the draw call is a plain non-indexed gl.LINES.
	const edgePositions = new Float32Array(edgeCount * 2 * 3);
	for (let e = 0; e < edgeCount; e++) {
		for (let k = 0; k < 2; k++) {
			const n = graph.edges[e * 2 + k]!;
			edgePositions[(e * 2 + k) * 3] = graph.positions[n * 3]!;
			edgePositions[(e * 2 + k) * 3 + 1] = graph.positions[n * 3 + 1]!;
			edgePositions[(e * 2 + k) * 3 + 2] = graph.positions[n * 3 + 2]!;
		}
	}

	/** Per-edge brightness, decaying every frame. Uploaded per vertex. */
	const edgeGlow = new Float32Array(edgeCount);
	const edgeGlowVerts = new Float32Array(edgeCount * 2);
	const nodeFlash = new Float32Array(NODE_COUNT);
	const pulsePositions = new Float32Array((PULSE_COUNT + HOVER_PULSE_MAX) * 3);

	/** Edge index for an unordered node pair, for lighting the right line. */
	const edgeIndex = new Map<number, number>();
	for (let e = 0; e < edgeCount; e++) {
		const a = graph.edges[e * 2]!;
		const b = graph.edges[e * 2 + 1]!;
		edgeIndex.set(a < b ? a * NODE_COUNT + b : b * NODE_COUNT + a, e);
	}

	/* ------------------------------------------------------------- gpu setup */

	let gpu: Gpu | null = null;

	function createGpu(): Gpu | null {
		const bgProg = link(gl, BG_VS, BG_FS);
		const nodeProg = link(gl, NODE_VS, NODE_FS);
		const edgeProg = link(gl, EDGE_VS, EDGE_FS);
		const pulseProg = link(gl, PULSE_VS, PULSE_FS);
		if (!bgProg || !nodeProg || !edgeProg || !pulseProg) return null;

		const buffer = (data: Float32Array, usage: number): WebGLBuffer | null => {
			const buf = gl.createBuffer();
			if (!buf) return null;
			gl.bindBuffer(gl.ARRAY_BUFFER, buf);
			gl.bufferData(gl.ARRAY_BUFFER, data, usage);
			return buf;
		};

		// A full-screen triangle, not a quad: one fewer vertex and no diagonal
		// seam where the two halves meet.
		const quadBuf = buffer(new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
		const nodePosBuf = buffer(graph.positions, gl.STATIC_DRAW);
		const nodeSeedBuf = buffer(graph.seeds, gl.STATIC_DRAW);
		const nodeFlashBuf = buffer(nodeFlash, gl.DYNAMIC_DRAW);
		const edgePosBuf = buffer(edgePositions, gl.STATIC_DRAW);
		const edgeGlowBuf = buffer(edgeGlowVerts, gl.DYNAMIC_DRAW);
		const pulseBuf = buffer(pulsePositions, gl.DYNAMIC_DRAW);

		if (
			!quadBuf ||
			!nodePosBuf ||
			!nodeSeedBuf ||
			!nodeFlashBuf ||
			!edgePosBuf ||
			!edgeGlowBuf ||
			!pulseBuf
		) {
			return null;
		}

		return {
			bgProg,
			nodeProg,
			edgeProg,
			pulseProg,
			quadBuf,
			nodePosBuf,
			nodeSeedBuf,
			nodeFlashBuf,
			edgePosBuf,
			edgeGlowBuf,
			pulseBuf,
		};
	}

	const bindAttrib = (prog: WebGLProgram, name: string, buf: WebGLBuffer, size: number) => {
		const loc = gl.getAttribLocation(prog, name);
		if (loc < 0) return;
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
	};

	/* ---------------------------------------------------------------- pulses */

	let rngState = 0x1234567;
	const rand = () => {
		rngState |= 0;
		rngState = (rngState + 0x6d2b79f5) | 0;
		let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	/** A walk of `hops` edges that never immediately doubles back. */
	function makePath(hops: number): number[] {
		const start = Math.floor(rand() * NODE_COUNT);
		const path = [start];
		let prev = -1;
		let cur = start;
		for (let i = 0; i < hops; i++) {
			const neighbours = graph.adjacency[cur]!.filter((n) => n !== prev);
			const pool = neighbours.length ? neighbours : graph.adjacency[cur]!;
			if (!pool.length) break;
			const next = pool[Math.floor(rand() * pool.length)]!;
			path.push(next);
			prev = cur;
			cur = next;
		}
		return path;
	}

	const newPulse = (wait: number): Pulse => ({
		// One edge, there and back.
		path: makePath(1),
		hop: 0,
		t: 0,
		// Slower than anything the reader provokes: ambient traffic is not urgent.
		speed: 1.8 + rand() * 0.8,
		returning: false,
		wait,
	});

	const pulses: Pulse[] = [];
	for (let i = 0; i < PULSE_COUNT; i++) pulses.push(newPulse(i * 1.3));

	/* ----------------------------------------------------------------- hover */

	/**
	 * Project every node into canvas device pixels. Only x, y and w are needed:
	 * the depth buffer is off, and w doubles as camera distance for the pick.
	 */
	function projectNodes(mvp: Mat4) {
		for (let i = 0; i < NODE_COUNT; i++) {
			const x = graph.positions[i * 3]!;
			const y = graph.positions[i * 3 + 1]!;
			const z = graph.positions[i * 3 + 2]!;
			// Column-major, so a row of the result reads m[col * 4 + row].
			const cx = mvp[0]! * x + mvp[4]! * y + mvp[8]! * z + mvp[12]!;
			const cy = mvp[1]! * x + mvp[5]! * y + mvp[9]! * z + mvp[13]!;
			const cw = mvp[3]! * x + mvp[7]! * y + mvp[11]! * z + mvp[15]!;
			const safe = Math.abs(cw) < 1e-4 ? 1e-4 : cw;
			screenXY[i * 2] = ((cx / safe) * 0.5 + 0.5) * width;
			screenXY[i * 2 + 1] = (1 - ((cy / safe) * 0.5 + 0.5)) * height;
			screenW[i] = cw;
		}
	}

	/**
	 * The node under the pointer, or -1. Nearest in screen space wins, with a
	 * penalty on camera distance so a node on the far side of the sphere cannot
	 * steal the pick from the one drawn in front of it. Held with hysteresis,
	 * since the sphere turns under a stationary pointer.
	 */
	function pickHovered() {
		if (!pointerSeen || reduceMotion.matches) return -1;

		const scale = dpr();
		const nearest = SPHERE_R * 1.1;
		const score = (i: number) => {
			if (screenW[i]! <= 0) return Infinity;
			const dx = screenXY[i * 2]! - hoverX;
			const dy = screenXY[i * 2 + 1]! - hoverY;
			// Distance from the front of the sphere, in world units.
			const depth = Math.max(0, screenW[i]! - (cameraDist - nearest));
			return Math.hypot(dx, dy) + depth * HOVER_DEPTH_PENALTY * scale;
		};

		let best = -1;
		let bestScore = HOVER_RADIUS * scale;
		for (let i = 0; i < NODE_COUNT; i++) {
			const s = score(i);
			if (s < bestScore) {
				bestScore = s;
				best = i;
			}
		}

		if (hoverNode >= 0) {
			const held = score(hoverNode);
			if (
				held <= HOVER_RELEASE * scale &&
				(best < 0 || bestScore > held - HOVER_HANDOVER * scale)
			) {
				return hoverNode;
			}
		}

		return best;
	}

	/**
	 * One round trip along each edge of the hovered node, staggered so they leave
	 * in sequence, and now and then one that carries on a hop further first.
	 */
	function emitWave(from: number) {
		const neighbours = graph.adjacency[from];
		if (!neighbours) return;

		for (const [i, neighbour] of neighbours.entries()) {
			if (pulses.length >= PULSE_COUNT + HOVER_PULSE_MAX) return;
			const path = [from, neighbour];

			// Anywhere but back the way it came, so it reads as a chain of hops
			// rather than a bounce.
			if (rand() < HOVER_SECOND_HOP_CHANCE) {
				const onward = graph.adjacency[neighbour]!.filter((n) => n !== from);
				if (onward.length > 0) path.push(onward[Math.floor(rand() * onward.length)]!);
			}

			pulses.push({
				path,
				hop: 0,
				t: 0,
				// Quicker than the ambient traffic: this one was asked for.
				speed: 3.4 + rand() * 1.2,
				returning: false,
				wait: i * HOVER_STAGGER,
				oneShot: true,
			});
		}
	}

	/* ------------------------------------------------------------------ view */

	let palette = readPalette(document.documentElement);
	let width = 1;
	let height = 1;
	let pointerX = 0;
	let pointerY = 0;
	let targetX = 0;
	let targetY = 0;

	// Hover. `hoverX/Y` are canvas-relative device pixels, which is the space the
	// projection below lands in. The canvas rect is cached by `resize`, which
	// already reads it once a frame.
	let hoverX = 0;
	let hoverY = 0;
	let pointerSeen = false;
	let hoverNode = -1;
	/** Eased towards 1 while a node is held, so it grows in and out. */
	let hoverEase = 0;
	let nextWaveAt = 0;
	/** Seconds since the loop started, for the wave clock. */
	let clock = 0;
	let rectLeft = 0;
	let rectTop = 0;
	/** Camera distance for the current frame, set in `frame`. */
	let cameraDist = 4;
	/** Screen-space node positions in device pixels, plus camera distance. */
	const screenXY = new Float32Array(NODE_COUNT * 2);
	const screenW = new Float32Array(NODE_COUNT);

	const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
	const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

	function resize() {
		const rect = canvas.getBoundingClientRect();
		rectLeft = rect.left;
		rectTop = rect.top;
		const w = Math.max(1, Math.round(rect.width * dpr()));
		const h = Math.max(1, Math.round(rect.height * dpr()));
		if (w === canvas.width && h === canvas.height) return;
		canvas.width = w;
		canvas.height = h;
		width = w;
		height = h;
	}

	/* ----------------------------------------------------------------- frame */

	let spin = 0;
	let last = 0;
	let raf = 0;
	let running = false;

	function simulate(dt: number, still: boolean) {
		for (let e = 0; e < edgeCount; e++) {
			edgeGlow[e] = Math.max(0, edgeGlow[e]! - dt * 1.45);
		}
		for (let n = 0; n < NODE_COUNT; n++) {
			nodeFlash[n] = Math.max(0, nodeFlash[n]! - dt * 2.5);
		}

		pulsePositions.fill(0);
		let live = 0;

		// Backwards, so a one-shot pulse can be spliced out without disturbing the
		// indices still to be visited.
		for (let i = pulses.length - 1; i >= 0; i--) {
			const p = pulses[i]!;
			if (p.wait > 0) {
				if (!still) p.wait -= dt;
				continue;
			}

			if (!still) p.t += dt * p.speed;

			let retired = false;
			while (p.t >= 1) {
				p.t -= 1;
				p.hop++;
				const arrivedAt = p.returning
					? p.path[Math.max(0, p.path.length - 1 - p.hop)]
					: p.path[Math.min(p.hop, p.path.length - 1)];
				if (arrivedAt !== undefined) nodeFlash[arrivedAt] = 1;

				if (p.hop >= p.path.length - 1) {
					if (p.returning) {
						// Home again: the whole chain cost one trip. Hover traffic is
						// done; ambient traffic rests, then goes again.
						if (p.oneShot) pulses.splice(i, 1);
						else pulses[i] = newPulse(AMBIENT_REST_MIN + rand() * AMBIENT_REST_SPAN);
						retired = true;
						break;
					}
					p.returning = true;
					p.hop = 0;
				}
			}
			if (retired || p.path.length < 2) continue;

			const n = p.path.length;
			const fromIdx = p.returning ? n - 1 - p.hop : p.hop;
			const toIdx = p.returning ? n - 2 - p.hop : p.hop + 1;
			const a = p.path[fromIdx];
			const b = p.path[toIdx];
			if (a === undefined || b === undefined) continue;

			const ei = edgeIndex.get(a < b ? a * NODE_COUNT + b : b * NODE_COUNT + a);
			if (ei !== undefined) edgeGlow[ei] = 1;

			const t = p.t;
			pulsePositions[live * 3] =
				graph.positions[a * 3]! + (graph.positions[b * 3]! - graph.positions[a * 3]!) * t;
			pulsePositions[live * 3 + 1] =
				graph.positions[a * 3 + 1]! +
				(graph.positions[b * 3 + 1]! - graph.positions[a * 3 + 1]!) * t;
			pulsePositions[live * 3 + 2] =
				graph.positions[a * 3 + 2]! +
				(graph.positions[b * 3 + 2]! - graph.positions[a * 3 + 2]!) * t;
			live++;
		}

		for (let e = 0; e < edgeCount; e++) {
			edgeGlowVerts[e * 2] = edgeGlow[e]!;
			edgeGlowVerts[e * 2 + 1] = edgeGlow[e]!;
		}
		return live;
	}

	function frame(now: number) {
		raf = 0;
		const g = gpu;
		if (!g) return;

		const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
		last = now;

		resize();
		gl.viewport(0, 0, width, height);

		const still = reduceMotion.matches;
		if (!still) spin += dt * 0.055;

		// Pointer parallax, eased. Held at zero when motion is reduced.
		targetX += (pointerX - targetX) * Math.min(1, dt * 3);
		targetY += (pointerY - targetY) * Math.min(1, dt * 3);

		const aspect = width / height;
		const dist = aspect < 0.9 ? 4.6 : 4.0;
		cameraDist = dist;
		const view = lookAtOrigin(0, 0, dist);
		const proj = perspective((aspect < 0.9 ? 52 : 44) * (Math.PI / 180), aspect, 0.1, 20);
		const model = multiply(rotationX(-0.22 + targetY * 0.13), rotationY(spin + targetX * 0.24));
		const mvp = multiply(proj, multiply(view, model));

		// Hover. The pick has to happen after the model matrix is known, since the
		// sphere is turning and the node under the pointer changes with it.
		if (!still) {
			clock += dt;
			projectNodes(mvp);
			const picked = pickHovered();
			if (picked !== hoverNode) {
				hoverNode = picked;
				if (picked >= 0) {
					emitWave(picked);
					nextWaveAt = clock + HOVER_WAVE_GAP;
				}
			} else if (hoverNode >= 0 && clock >= nextWaveAt) {
				emitWave(hoverNode);
				nextWaveAt = clock + HOVER_WAVE_GAP;
			}
			hoverEase += ((hoverNode >= 0 ? 1 : 0) - hoverEase) * Math.min(1, dt * 9);
		}

		const livePulses = simulate(dt, still);

		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.BLEND);

		gl.useProgram(g.bgProg);
		bindAttrib(g.bgProg, 'a_pos', g.quadBuf, 2);
		gl.uniform3fv(gl.getUniformLocation(g.bgProg, 'u_inner'), palette.bgInner);
		gl.uniform3fv(gl.getUniformLocation(g.bgProg, 'u_outer'), palette.bgOuter);
		gl.uniform1f(gl.getUniformLocation(g.bgProg, 'u_aspect'), aspect);
		gl.drawArrays(gl.TRIANGLES, 0, 3);

		/*
		 * Both paths below expect premultiplied colour out of the fragment
		 * shaders (`rgb * a, a`), which is why the light path uses
		 * (ONE, ONE_MINUS_SRC_ALPHA) rather than (SRC_ALPHA, ...).
		 */
		gl.enable(gl.BLEND);
		// Glow on black and ink on paper are different drawings, not one drawing in
		// two palettes, so the blend function changes with the scheme.
		if (palette.light >= 0.5) {
			// Normal "over": dark ink laid onto a pale page.
			gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		} else {
			// Additive: overlapping glow accumulates into light.
			gl.blendFunc(gl.ONE, gl.ONE);
		}

		const hot = 1 - palette.light;
		// Ink on paper carries much further than glow on black, so the light
		// scheme needs materially less of it to read as the same drawing.
		const edgeBase = 0.3;
		const nodeScale = (21 - 4 * palette.light) * dpr();

		gl.useProgram(g.edgeProg);
		bindAttrib(g.edgeProg, 'a_pos', g.edgePosBuf, 3);
		gl.bindBuffer(gl.ARRAY_BUFFER, g.edgeGlowBuf);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgeGlowVerts);
		bindAttrib(g.edgeProg, 'a_glow', g.edgeGlowBuf, 1);
		gl.uniformMatrix4fv(gl.getUniformLocation(g.edgeProg, 'u_mvp'), false, mvp);
		gl.uniform3fv(gl.getUniformLocation(g.edgeProg, 'u_color'), palette.edge);
		gl.uniform3fv(gl.getUniformLocation(g.edgeProg, 'u_hotColor'), palette.pulse);
		gl.uniform1f(gl.getUniformLocation(g.edgeProg, 'u_base'), edgeBase);
		gl.drawArrays(gl.LINES, 0, edgeCount * 2);

		gl.useProgram(g.nodeProg);
		bindAttrib(g.nodeProg, 'a_pos', g.nodePosBuf, 3);
		bindAttrib(g.nodeProg, 'a_seed', g.nodeSeedBuf, 1);
		gl.bindBuffer(gl.ARRAY_BUFFER, g.nodeFlashBuf);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, nodeFlash);
		bindAttrib(g.nodeProg, 'a_flash', g.nodeFlashBuf, 1);
		gl.uniformMatrix4fv(gl.getUniformLocation(g.nodeProg, 'u_mvp'), false, mvp);
		gl.uniform1f(gl.getUniformLocation(g.nodeProg, 'u_time'), now / 1000);
		gl.uniform1f(gl.getUniformLocation(g.nodeProg, 'u_scale'), nodeScale);
		gl.uniform1f(gl.getUniformLocation(g.nodeProg, 'u_hot'), hot);
		gl.uniform1i(gl.getUniformLocation(g.nodeProg, 'u_hover'), hoverEase > 0.01 ? hoverNode : -1);
		gl.uniform1f(gl.getUniformLocation(g.nodeProg, 'u_hoverEase'), hoverEase);
		const blink = 0.5 + 0.5 * Math.sin((now / 1000) * BLINK_RATE);
		// White is the bright end of the blink on the dark field. On the pale one it
		// would be a white dot on near-white paper, so it is warmed towards the
		// message colour in proportion to how light the field is.
		const bright = mixRgb(WHITE, palette.pulse, 0.5 * palette.light);
		gl.uniform3fv(
			gl.getUniformLocation(g.nodeProg, 'u_hoverColor'),
			mixRgb(bright, palette.pulse, blink)
		);
		gl.uniform3fv(gl.getUniformLocation(g.nodeProg, 'u_color'), palette.node);
		gl.uniform3fv(gl.getUniformLocation(g.nodeProg, 'u_flashColor'), palette.pulse);
		gl.drawArrays(gl.POINTS, 0, NODE_COUNT);

		if (livePulses > 0) {
			gl.useProgram(g.pulseProg);
			gl.bindBuffer(gl.ARRAY_BUFFER, g.pulseBuf);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, pulsePositions);
			bindAttrib(g.pulseProg, 'a_pos', g.pulseBuf, 3);
			gl.uniformMatrix4fv(gl.getUniformLocation(g.pulseProg, 'u_mvp'), false, mvp);
			gl.uniform1f(gl.getUniformLocation(g.pulseProg, 'u_scale'), 26 * dpr());
			gl.uniform1f(gl.getUniformLocation(g.pulseProg, 'u_hot'), hot);
			gl.uniform3fv(gl.getUniformLocation(g.pulseProg, 'u_color'), palette.pulse);
			gl.drawArrays(gl.POINTS, 0, livePulses);
		}

		// Reduced motion gets exactly one frame: a still portrait of the network.
		if (running && !still) raf = requestAnimationFrame(frame);
	}

	/** Draw once even while parked -- after a resize, theme flip or restore. */
	function repaint() {
		if (raf) return;
		last = 0;
		raf = requestAnimationFrame(frame);
	}

	function start() {
		if (running || !gpu) return;
		running = true;
		last = 0;
		if (!raf) raf = requestAnimationFrame(frame);
	}

	function stop() {
		running = false;
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	}

	/* ---------------------------------------------------------------- events */

	const onPointer = (e: PointerEvent) => {
		if (e.pointerType !== 'mouse' || reduceMotion.matches) return;
		pointerX = (e.clientX / window.innerWidth) * 2 - 1;
		pointerY = (e.clientY / window.innerHeight) * 2 - 1;
		const scale = dpr();
		hoverX = (e.clientX - rectLeft) * scale;
		hoverY = (e.clientY - rectTop) * scale;
		pointerSeen = true;
	};
	window.addEventListener('pointermove', onPointer, { passive: true });

	// Nothing should be left lit behind a pointer that has gone away.
	const releaseHover = () => {
		pointerSeen = false;
	};
	document.addEventListener('pointerleave', releaseHover);
	window.addEventListener('blur', releaseHover);

	// Only animate while actually on screen.
	const io = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) start();
				else stop();
			}
		},
		{ threshold: 0 }
	);
	io.observe(canvas);

	const onVisibility = () => {
		if (document.hidden) stop();
		else start();
	};
	document.addEventListener('visibilitychange', onVisibility);

	const ro = new ResizeObserver(() => {
		resize();
		if (!running || reduceMotion.matches) repaint();
	});
	ro.observe(canvas);

	// Re-read the palette when the theme flips. A running loop picks the new
	// colours up on its next frame; a parked one needs telling to paint once.
	const themeObserver = new MutationObserver(() => {
		palette = readPalette(document.documentElement);
		if (!running && !document.hidden) repaint();
	});
	themeObserver.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['data-theme'],
	});

	const onMotionChange = () => {
		last = 0;
		if (reduceMotion.matches) repaint();
		else start();
	};
	reduceMotion.addEventListener('change', onMotionChange);

	/*
	 * Context loss is not hypothetical -- GPU driver resets, waking from sleep
	 * and tab discarding all cause it, and the browser expects the page to
	 * rebuild rather than give up. Calling preventDefault on the loss event is
	 * what makes the restore event fire at all.
	 */
	const onLost = (e: Event) => {
		e.preventDefault();
		stop();
		gpu = null;
		canvas.dataset.state = 'lost';
	};

	const onRestored = () => {
		gpu = createGpu();
		if (!gpu) {
			canvas.dataset.state = 'unsupported';
			return;
		}
		canvas.dataset.state = 'ready';
		// Force a fresh upload at the new context's sizes.
		canvas.width = 0;
		resize();
		start();
		repaint();
	};

	canvas.addEventListener('webglcontextlost', onLost);
	canvas.addEventListener('webglcontextrestored', onRestored);

	gpu = createGpu();
	if (!gpu) {
		canvas.dataset.state = 'unsupported';
		canvas.removeEventListener('webglcontextlost', onLost);
		canvas.removeEventListener('webglcontextrestored', onRestored);
		window.removeEventListener('pointermove', onPointer);
		document.removeEventListener('pointerleave', releaseHover);
		window.removeEventListener('blur', releaseHover);
		document.removeEventListener('visibilitychange', onVisibility);
		reduceMotion.removeEventListener('change', onMotionChange);
		io.disconnect();
		ro.disconnect();
		themeObserver.disconnect();
		return () => {};
	}

	canvas.dataset.state = 'ready';
	resize();
	start();

	return () => {
		stop();
		gpu = null;
		io.disconnect();
		ro.disconnect();
		themeObserver.disconnect();
		reduceMotion.removeEventListener('change', onMotionChange);
		document.removeEventListener('visibilitychange', onVisibility);
		window.removeEventListener('pointermove', onPointer);
		document.removeEventListener('pointerleave', releaseHover);
		window.removeEventListener('blur', releaseHover);
		canvas.removeEventListener('webglcontextlost', onLost);
		canvas.removeEventListener('webglcontextrestored', onRestored);
	};
}
