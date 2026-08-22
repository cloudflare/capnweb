/*
 * Re-derives every number `build-wordmark.mjs` took off capnproto.org.
 *
 *   node scripts/measure-wordmark.mjs              # fetches the reference art
 *   node scripts/measure-wordmark.mjs logo.png infinitely_faster.png
 *
 * The wordmark is a parody of capnproto.org's, and the build script is full of
 * constants that only mean anything because they were measured off it: the
 * tilt of each line, how far the letters scatter off that line, how much
 * bigger the first letter of the lower line is, how many points the seal has
 * and how deep they cut. Those measurements were originally taken with a pile
 * of throwaway scripts. This is that pile, cleaned up and committed, so the
 * constants can be checked rather than trusted -- and so the mark can be
 * rebuilt from the reference if it is ever lost.
 *
 * It reports what it measures next to what the build script currently uses,
 * and explains the ones that deliberately differ. Nothing here writes files.
 *
 * No dependencies, on purpose. The originals decoded PNGs by handing them to a
 * headless Chrome canvas, which is a browser download to read 226k pixels; the
 * decoder below is ~50 lines of `node:zlib` and covers the only format these
 * two files are in (8-bit RGBA, non-interlaced). It refuses anything else
 * loudly rather than quietly mismeasuring.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const SOURCES = {
	logo: 'https://capnproto.org/images/logo.png',
	seal: 'https://capnproto.org/images/infinitely_faster.png',
};

/* ------------------------------------------------------------------ PNG -- */

/** Decodes an 8-bit RGBA non-interlaced PNG to `{ w, h, data }`. */
function decodePng(buf) {
	const sig = [137, 80, 78, 71, 13, 10, 26, 10];
	if (!sig.every((b, i) => buf[i] === b)) throw new Error('not a PNG');

	const w = buf.readUInt32BE(16);
	const h = buf.readUInt32BE(20);
	const [depth, color, , , interlace] = [buf[24], buf[25], buf[26], buf[27], buf[28]];
	if (depth !== 8 || color !== 6 || interlace !== 0) {
		throw new Error(
			`unsupported PNG (depth ${depth}, colour type ${color}, interlace ${interlace}). ` +
				'This decoder only handles 8-bit RGBA, non-interlaced -- which is what both ' +
				'reference files are. Re-encode, or decode it some other way.',
		);
	}

	const idat = [];
	for (let o = 8; o < buf.length; ) {
		const len = buf.readUInt32BE(o);
		const type = buf.toString('ascii', o + 4, o + 8);
		if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
		if (type === 'IEND') break;
		o += 12 + len;
	}
	const raw = zlib.inflateSync(Buffer.concat(idat));

	/* Undo the per-scanline filters. Each row is one filter byte then w*4
	   bytes; filters 1-4 predict from the pixel left (a), above (b), and
	   above-left (c). See the PNG spec, chapter 9. */
	const bpp = 4;
	const stride = w * bpp;
	const out = Buffer.alloc(h * stride);
	for (let y = 0; y < h; y++) {
		const ft = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const dst = y * stride;
		for (let i = 0; i < stride; i++) {
			const x = raw[src + i];
			const a = i >= bpp ? out[dst + i - bpp] : 0;
			const b = y > 0 ? out[dst - stride + i] : 0;
			const c = i >= bpp && y > 0 ? out[dst - stride + i - bpp] : 0;
			let v;
			if (ft === 0) v = x;
			else if (ft === 1) v = x + a;
			else if (ft === 2) v = x + b;
			else if (ft === 3) v = x + ((a + b) >> 1);
			else if (ft === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
			} else throw new Error(`bad PNG filter ${ft} on row ${y}`);
			out[dst + i] = v & 0xff;
		}
	}
	return { w, h, data: out };
}

async function load(which, argPath) {
	if (argPath) return decodePng(fs.readFileSync(argPath));
	const url = SOURCES[which];
	let res;
	try {
		res = await fetch(url);
	} catch (cause) {
		throw new Error(
			`could not fetch ${url}: ${cause.message}\n` +
				'If you are offline, download the two reference images anywhere and pass them:\n' +
				`  node scripts/measure-wordmark.mjs logo.png infinitely_faster.png\n` +
				`  ${SOURCES.logo}\n  ${SOURCES.seal}`,
			{ cause },
		);
	}
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
	return decodePng(Buffer.from(await res.arrayBuffer()));
}

/* --------------------------------------------------- connected components -- */

/**
 * 8-connected components over opaque pixels, as bounding boxes.
 *
 * The reference letters are white with a black keyline, and both are opaque,
 * so a component is a whole letter rather than one of its two colours. Holes
 * (the counter of an O) are background and never their own component.
 */
function components(img, minPx) {
	const { w, h, data } = img;
	const ink = (x, y) => data[(y * w + x) * 4 + 3] > 128;
	const seen = new Uint8Array(w * h);
	const boxes = [];
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!ink(x, y) || seen[y * w + x]) continue;
			seen[y * w + x] = 1;
			const stack = [[x, y]];
			let x0 = x;
			let x1 = x;
			let y0 = y;
			let y1 = y;
			let n = 0;
			while (stack.length) {
				const [px, py] = stack.pop();
				n++;
				if (px < x0) x0 = px;
				if (px > x1) x1 = px;
				if (py < y0) y0 = py;
				if (py > y1) y1 = py;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const nx = px + dx;
						const ny = py + dy;
						if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
						if (seen[ny * w + nx] || !ink(nx, ny)) continue;
						seen[ny * w + nx] = 1;
						stack.push([nx, ny]);
					}
				}
			}
			if (n >= minPx) boxes.push({ x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, px: n });
		}
	}
	return boxes.sort((a, z) => a.x0 - z.x0);
}

/** Splits boxes into rows by a gap in their vertical centres. */
function rows(boxes) {
	const sorted = [...boxes].sort((a, z) => (a.y0 + a.y1) / 2 - (z.y0 + z.y1) / 2);
	const out = [];
	let cur = [sorted[0]];
	for (const b of sorted.slice(1)) {
		const prev = cur[cur.length - 1];
		const gap = (b.y0 + b.y1) / 2 - (prev.y0 + prev.y1) / 2;
		if (gap > Math.max(prev.h, b.h) * 0.6) {
			out.push(cur);
			cur = [];
		}
		cur.push(b);
	}
	out.push(cur);
	return out.map((r) => r.sort((a, z) => a.x0 - z.x0));
}

/**
 * The glyphs on a row that actually sit on the baseline.
 *
 * `CAP'N` contains an apostrophe, which hangs at cap height and has its feet
 * nowhere near the baseline. Including it drags a least-squares fit through
 * the floor: with it the upper line measures -11.6 degrees and shows a 59px
 * residual, against -5.2 and 22px once it is dropped. Anything much shorter
 * than the line's tallest letter is punctuation, not a letter.
 */
const feet = (row) => {
	const tall = Math.max(...row.map((b) => b.h));
	return row.filter((b) => b.h >= tall * 0.55);
};

/**
 * Cap height for a row: the median of its baseline glyphs, ignoring an
 * oversized initial.
 *
 * Not the maximum. On the lower line the maximum *is* the oversized initial,
 * which reports the cap 38% too tall and makes the two lines look far more
 * different in size than they are. The median also shrugs off the overshoot
 * that round letters carry above and below the line.
 */
function capHeight(row) {
	const hs = feet(row).map((b) => b.h);
	const rest = hs.length > 2 ? hs.slice(1) : hs;
	const sorted = [...rest].sort((a, z) => a - z);
	return sorted[Math.floor(sorted.length / 2)];
}

/** Least-squares fit of y = m*x + c through a line's glyph feet. */
function baseline(row) {
	const pts = feet(row).map((b) => [(b.x0 + b.x1) / 2, b.y1]);
	const n = pts.length;
	const sx = pts.reduce((a, p) => a + p[0], 0);
	const sy = pts.reduce((a, p) => a + p[1], 0);
	const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0);
	const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
	const m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
	const c = (sy - m * sx) / n;
	return {
		m,
		c,
		degrees: (Math.atan(m) * 180) / Math.PI,
		residuals: pts.map(([x, y]) => y - (m * x + c)),
	};
}

/* ---------------------------------------------------------------- report -- */

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Pulls the committed constants out of the build script's source.
 *
 * Reading the source rather than importing it is deliberate: importing would
 * execute it, and it wants a font file, `opentype.js`, and somewhere to write
 * two generated files. This only needs the numbers. A pattern that stops
 * matching reports itself as `?` rather than silently agreeing.
 */
function committed() {
	const src = fs.readFileSync(new URL('./build-wordmark.mjs', import.meta.url), 'utf8');
	const one = (re) => {
		const m = src.match(re);
		return m ? m.slice(1).map(Number) : null;
	};
	const capn = src.match(/text: 'CAP\\u2019N',[\s\S]*?tilt: (-?[\d.]+)/);
	const web = src.match(/text: 'WEB',[\s\S]*?size: (\d+)[\s\S]*?tilt: (-?[\d.]+)/);
	const capnSize = src.match(/text: 'CAP\\u2019N',\s*\n\s*size: (\d+)/);
	return {
		capnTilt: capn ? Number(capn[1]) : null,
		capnSize: capnSize ? Number(capnSize[1]) : null,
		webSize: web ? Number(web[1]) : null,
		webTilt: web ? Number(web[2]) : null,
		/* Anchored on the CAP'N entry rather than on whatever happens to follow
		   the array, so that editing a neighbouring field does not silently
		   turn this into a `?`. */
		capnDy: (() => {
			const m = src.match(/text: 'CAP\\u2019N',[\s\S]*?dy: \[([-\d.,\s]+)\]/);
			return m ? m[1].split(',').map((s) => Number(s.trim())) : null;
		})(),
		initial: one(/initial: ([\d.]+)/),
		lead: one(/const LEAD = ([\d.]+);/),
		indent: one(/const INDENT = ([\d.]+);/),
		star: one(/const STAR_PATH = star\((\d+), ([\d.]+), ([\d.]+)\);/),
		favPoints: one(/const FAVICON_POINTS = (\d+);/),
		favRatio: one(/const FAVICON_RATIO = ([\d.]+);/),
	};
}

const say = (label, measured, used, note) =>
	console.log(
		`  ${label.padEnd(30)} measured ${String(measured).padStart(9)}` +
			(used === undefined ? '' : `   uses ${String(used).padStart(8)}`) +
			(note ? `   ${note}` : ''),
	);

const [, , logoPath, sealPath] = process.argv;
const C = committed();

/* ------------------------------------------------------------- wordmark -- */

const logo = await load('logo', logoPath);
console.log(`\nlogo.png  ${logo.w}x${logo.h}`);

/* The tagline ("cerealization protocol") is a third row of much smaller
   letters. Rows are found by gaps rather than by a hardcoded cutoff, then the
   two with the tallest letters are the wordmark. */
const all = rows(components(logo, 300));
const lines = [...all].sort((a, z) => Math.max(...z.map((b) => b.h)) - Math.max(...a.map((b) => b.h))).slice(0, 2);
lines.sort((a, z) => a[0].y0 - z[0].y0);
const [upper, lower] = lines;

console.log(
	`\n  rows found: ${all.map((r) => `${r.length} glyphs (cap ${capHeight(r)})`).join(', ')}` +
		"\n  The tagline ('cerealization protocol') is set small enough that every" +
		'\n  letter falls under the pixel threshold, so it never becomes a row.\n',
);

const bUpper = baseline(upper);
const bLower = baseline(lower);

const capUpper = capHeight(upper);
const capLower = capHeight(lower);

console.log('CAP\'N (upper line)');
say('tilt, degrees', r2(bUpper.degrees), C.capnTilt, 'least squares through the feet');
say('cap height, px', capUpper, undefined, `build sets size ${C.capnSize ?? '?'} in design units`);
say('glyph heights, px', `[${feet(upper).map((g) => g.h).join(', ')}]`, undefined, 'they differ: the mark is scattered');
say('scatter off baseline, px', r1(Math.max(...bUpper.residuals) - Math.min(...bUpper.residuals)));
say('per-glyph residuals', `[${bUpper.residuals.map(r1).join(', ')}]`, `[${C.capnDy ?? '?'}]`);
console.log(
	'    ^ the build script carries these as `dy`, and has one more of them than\n' +
		'      this measures: its fifth is the apostrophe, which hangs at cap height\n' +
		'      and so is left out of the baseline fit entirely.\n' +
		'      They are the whole argument for the jitter: a hand-set mark\n' +
		'      scatters, a rendered one does not.\n',
);

console.log('PROTO (lower line) -> WEB');
say('tilt, degrees', r2(bLower.degrees), C.webTilt, 'least squares through the feet');
say('cap height, px', capLower, undefined, `build sets size ${C.webSize ?? '?'} in design units`);
say('glyph heights, px', `[${feet(lower).map((g) => g.h).join(', ')}]`, undefined, 'first is the oversized initial');
say('scatter off baseline, px', r1(Math.max(...bLower.residuals) - Math.min(...bLower.residuals)));

/* The oversized initial, against the cap height of the letters after it. */
say('initial / rest, by height', r3(feet(lower)[0].h / capLower), C.initial?.[0], 'W is dialled back');

console.log('\nboth lines');
const capRatio = capLower / capUpper;
say('cap ratio, lower/upper', r3(capRatio), r3((C.webSize ?? 0) / (C.capnSize ?? 1)), 'ours is higher on purpose');
const midX = (lower[0].x0 + lower[lower.length - 1].x1) / 2;
const gapPx = bLower.m * midX + bLower.c - (bUpper.m * midX + bUpper.c);
say('baseline gap, px', r1(gapPx));
say('gap / lower cap = LEAD', r3(gapPx / capLower), C.lead?.[0], 'opened up; WEB has no free space');
const wUpper = upper[upper.length - 1].x1 - upper[0].x0;
const wLower = lower[lower.length - 1].x1 - lower[0].x0;
const cUpper = (upper[upper.length - 1].x1 + upper[0].x0) / 2;
const cLower = (lower[lower.length - 1].x1 + lower[0].x0) / 2;
say('upper indent / lower width', r3((cUpper - cLower) / wLower), C.indent?.[0], 'INDENT');
say('line widths, px', `${wUpper} / ${wLower}`, undefined, `lower/upper ${r2(wLower / wUpper)}`);

/* ----------------------------------------------------------------- seal -- */

const seal = await load('seal', sealPath);
console.log(`\ninfinitely_faster.png  ${seal.w}x${seal.h}`);

/* Radius profile from the ink centroid. The peaks are the star's points and
   the troughs are the valleys between them, so counting one and taking the
   ratio of the two gives the whole shape. */
const { w: sw, h: sh, data: sd } = seal;
let cx = 0;
let cy = 0;
let n = 0;
for (let y = 0; y < sh; y++) {
	for (let x = 0; x < sw; x++) {
		if (sd[(y * sw + x) * 4 + 3] > 128) {
			cx += x;
			cy += y;
			n++;
		}
	}
}
cx /= n;
cy /= n;

const STEPS = 3600;
const radii = new Array(STEPS);
for (let i = 0; i < STEPS; i++) {
	const a = (i / STEPS) * Math.PI * 2;
	const dx = Math.cos(a);
	const dy = Math.sin(a);
	let r = 0;
	for (let t = 1; t < Math.max(sw, sh); t += 0.5) {
		const x = Math.round(cx + dx * t);
		const y = Math.round(cy + dy * t);
		if (x < 0 || y < 0 || x >= sw || y >= sh) break;
		if (sd[(y * sw + x) * 4 + 3] > 128) r = t;
	}
	radii[i] = r;
}

/* A sample is a peak if it is the largest in a window wider than one point. */
const peaks = [];
const win = Math.floor(STEPS / 60);
for (let i = 0; i < STEPS; i++) {
	let best = true;
	for (let k = -win; k <= win && best; k++) {
		if (radii[(i + k + STEPS) % STEPS] > radii[i]) best = false;
	}
	if (best && (!peaks.length || i - peaks[peaks.length - 1] > win)) peaks.push(i);
}
const outer = radii.filter((r) => r > 0).sort((a, z) => z - a);
const inner = [...radii].sort((a, z) => a - z).filter((r) => r > 0);
const outerR = outer[Math.floor(outer.length * 0.02)];
const innerR = inner[Math.floor(inner.length * 0.02)];
const spacing = 360 / peaks.length;

console.log('\nthe seal');
say('points', peaks.length, C.star?.[0]);
say('inner / outer radius', r2(innerR / outerR), C.star?.[1]);
say('outer radius, px', r1(outerR), undefined, `of a ${sw}px image`);
say('point spacing, degrees', r2(spacing), undefined, 'exact, so the points are regular');
const first = (peaks[0] / STEPS) * 360;
say('first point, degrees', r2(first), C.star?.[2], 'the build script measures from -90');
const jitter = peaks.map((p, i) => ((p / STEPS) * 360 - (first + i * spacing) + 540) % 360 - 180);
say('worst deviation, degrees', r2(Math.max(...jitter.map(Math.abs))), undefined, 'regular, not hand-jittered');

console.log('\nthe favicon is not measured from anything');
say('points', 'n/a', C.favPoints?.[0], 'chosen for legibility at 16px');
say('inner / outer radius', 'n/a', C.favRatio?.[0], 'swept on real tab strips');

console.log(
	'\nReading the numbers\n' +
		'\n' +
		'Differences of about a pixel, or a few hundredths on a ratio, are method\n' +
		'and not drift. This script measures the bounding box of each letter\'s\n' +
		'ink at an alpha threshold; the values in the build script were taken by\n' +
		'fitting glyph outlines to the reference and maximising overlap, which\n' +
		'puts a baseline through the outline rather than through the darkest\n' +
		'row of pixels. The two agree to about a pixel everywhere, which is the\n' +
		'useful result: neither is exact, and the mark does not need them to be.\n' +
		'\n' +
		'Bigger gaps are deliberate, and the build script says why at each\n' +
		'constant. The short version: LEAD and INDENT are opened up, and the cap\n' +
		'ratio raised, because WEB is three letters where PROTO is five. At the\n' +
		'reference ratio the lower line comes out narrower than the upper one and\n' +
		'the lockup stops reading as a block.\n' +
		'\n' +
		'The seal is the part that is copied outright: 20 points on exact 18\n' +
		'degree centres, deviating a degree at most. It is a regular star, and an\n' +
		'earlier pass that jittered its points on the theory that a printed seal\n' +
		'would be irregular was measuring nothing.\n',
);
