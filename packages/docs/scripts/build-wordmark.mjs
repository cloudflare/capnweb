/*
 * Regenerates the Cap'n Web wordmark and seal:
 *
 *   src/components/logo-paths.ts   the lockup and the seal, as SVG path data
 *   public/favicon.svg             the seal alone, as a standalone file
 *
 * Not part of the build. It runs when the mark itself changes, which is close
 * to never, and it needs a font file and `opentype.js` that the site does not
 * otherwise depend on:
 *
 *   npm i opentype.js
 *   curl -sLO https://www.gust.org.pl/projects/e-foundry/tex-gyre/bonum/qbk2.004otf.zip
 *   unzip -j qbk2.004otf.zip 'texgyrebonum-bold.otf'
 *   node scripts/build-wordmark.mjs texgyrebonum-bold.otf
 *
 * Letterforms are TeX Gyre Bonum Bold, a Bookman clone under the GUST Font
 * License (a free licence modelled on the LPPL). Converting glyphs to outlines
 * is ordinary use of a font; only the resulting paths ship, never the font.
 *
 * URW Bookman Demi is the same design and is what capnproto.org's own mark is
 * set in, but it is AGPL-3 and its font exception covers only "a Postscript or
 * PDF file" -- not SVG on a web page. Bonum is the same shapes without that
 * problem. Do not swap it back.
 *
 * ---------------------------------------------------------------------------
 * Everything below is in the coordinate space of capnproto.org's `logo.png`,
 * which is 635px wide, so the measurements taken off that image are the numbers
 * written here. The mark is a parody of it and wants to sit at the same
 * proportions.
 */
import opentype from 'opentype.js';
import fs from 'node:fs';

const fontPath = process.argv[2] ?? new URL('./texgyrebonum-bold.otf', import.meta.url);
const font = opentype.parse(fs.readFileSync(fontPath).buffer);

/** Cap height as a fraction of em, used to space the two lines off each other. */
const CAP = font.charToGlyph('H').getMetrics().yMax / font.unitsPerEm;

/*
 * The reference is not text on a circle, which is what it looks like at a
 * glance. Fitting each glyph of `logo.png` independently -- best scale and
 * rotation by intersection-over-union -- and then least-squares fitting a
 * baseline through the results gives a straight, tilted line per word, with the
 * letters scattered around it.
 *
 * What makes it look hand-lettered rather than typed is that scatter, and it is
 * bigger than it looks: `CAP'N` deviates 21px peak-to-peak from its own
 * baseline, on a cap height of 100. Roughly a fifth of a letter. `PROTO` is
 * calmer at 9px on a cap of 124. Both words also sit at different angles.
 *
 * So each glyph carries three of its own numbers -- an extra rotation, a
 * baseline offset and a size multiplier -- on top of its line's tilt. For
 * `CAP'N` these are the reference's measured residuals. For `WEB` there is
 * nothing to measure, so they are invented to sit in the same range as
 * `PROTO`'s, including its habit of letting the middle letter ride high.
 *
 * `O` and `C` fit poorly (IoU 0.67) because a round letter is nearly invariant
 * under rotation, so their fitted *angles* are noise and were not used. Their
 * positions are fine -- round letters overshoot the baseline, which the fit
 * subtracts before measuring.
 */
const LINES = [
	{
		text: 'CAP\u2019N',
		size: 134,
		track: 6,
		tilt: -5.2,
		//        C      A      P      '      N
		rot: [3, 1, 0, 2, 4],
		dy: [-2.4, 10.2, -11.8, -4, 4.1],
		scale: [0.98, 1.01, 1.0, 1.0, 1.04],
	},
	{
		text: 'WEB',
		/*
		 * Against `CAP'N`'s 134 this is a cap-height ratio of 1.28. The
		 * reference is 1.24 (a 124px cap under a 100px one) and an earlier pass
		 * here was 1.39, which read as a second, louder logo rather than the
		 * second line of one. It is not taken all the way down to 1.24 because
		 * `WEB` is three letters where `PROTO` is five: at the reference's ratio
		 * the lower line ends up visibly narrower than the upper one, and the
		 * lockup stops looking like a block. This is the compromise -- the two
		 * lines come out within a few percent of the same width.
		 */
		size: 172,
		track: 4,
		tilt: -7.4,
		// The oversized initial is measured, not invented: `PROTO`'s P stands
		// 157px against a 124px cap, a ratio of 1.27, and fitting outlines to it
		// rather than measuring ink agrees at 1.24. But that is measured on a P,
		// and a W is already the widest, tallest-feeling letter in the alphabet
		// -- at 1.27 it swamps the lockup -- so it is dialled back. `CAP'N` has
		// no oversized initial; the reference's is uniform.
		initial: 1.15,
		//        W      E      B
		rot: [1, 2, 3],
		dy: [2.0, -6.0, 3.0],
		scale: [1.0, 1.0, 1.01],
	},
];

/*
 * Baseline-to-baseline, as a multiple of the lower line's cap height. Measured
 * 150px against a 124px cap on the reference, which is 1.21. The lines do not
 * interlock there: `PROTO`'s oversized P is far enough left that `CAP'N` never
 * reaches over it, so its extra height is free. `WEB` has no such luxury -- its
 * oversized initial sits directly under `CAP'N` -- so the lead is opened up
 * until the clearance the build prints matches the reference's 17-34px.
 */
const LEAD = 1.47;

/*
 * `CAP'N` sits right of centre over the longer word, by 9% of that word's
 * width on the reference. With the tilt, that is what stops the lockup reading
 * as a rectangle.
 */
const INDENT = 0.13;

/** Stroke width in design units. Half of it shows, outside the fill, under
 *  `paint-order: stroke`. The reference's outline is ~4px at this scale. */
const STROKE = 8;

const rad = (d) => (d * Math.PI) / 180;
const q = (n) => Math.round(n * 10) / 10;

/*
 * Closes every contour in an opentype.js path.
 *
 * opentype.js 2.0.0 returns glyph outlines as open runs of M/L/C/Q with no `Z`
 * anywhere, on the assumption that whoever fills them does not need one. That
 * assumption breaks this mark twice over. A fill does close an open subpath --
 * but with a straight chord from the last point back to the first, which cuts
 * the corner off a slab serif. And a *stroke* does not close it at all, so the
 * keyline is simply absent along each contour's final edge: letters came out
 * with nicked feet and gaps in their outlines, which looked for all the world
 * like neighbouring glyphs overprinting each other.
 *
 * Guarded against a future opentype.js that does emit `Z`, so this stays a
 * no-op rather than doubling up.
 */
function closeContours(path) {
	const out = [];
	const closeIfOpen = () => {
		if (out.length && out[out.length - 1].type !== 'Z') out.push({ type: 'Z' });
	};
	for (const c of path.commands) {
		if (c.type === 'M') closeIfOpen();
		out.push(c);
	}
	closeIfOpen();
	path.commands = out;
	return path;
}

/** Applies `fn` to every coordinate pair in an opentype.js path. */
function mapPath(path, fn) {
	for (const c of path.commands) {
		if (c.x !== undefined) [c.x, c.y] = fn(c.x, c.y);
		if (c.x1 !== undefined) [c.x1, c.y1] = fn(c.x1, c.y1);
		if (c.x2 !== undefined) [c.x2, c.y2] = fn(c.x2, c.y2);
	}
	return path;
}

const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
const grow = (b, x, y) => {
	b.x0 = Math.min(b.x0, x);
	b.y0 = Math.min(b.y0, y);
	b.x1 = Math.max(b.x1, x);
	b.y1 = Math.max(b.y1, y);
};

/** Per-glyph point size, folding in the oversized initial and the size jitter. */
function sizesFor({ text, size, initial, scale }) {
	return [...text].map((_, i) => size * (i === 0 && initial ? initial : 1) * (scale?.[i] ?? 1));
}

/** Advance widths and total width for one line. */
function measure(spec) {
	const chars = [...spec.text];
	const sizes = sizesFor(spec);
	const adv = chars.map(
		(ch, i) => (font.charToGlyph(ch).advanceWidth * sizes[i]) / font.unitsPerEm + spec.track,
	);
	return { chars, sizes, adv, width: adv.reduce((a, b) => a + b, 0) - spec.track };
}

/*
 * One line of the lockup as *one path per glyph*, plus its own tilted bbox.
 *
 * Per glyph, not one path for the line, and that is not a stylistic choice. In
 * a single path the letters are subpaths of one shape: the fill floods their
 * union, and because `paint-order: stroke` paints every subpath's keyline first
 * and then covers it with that union, any keyline running through an overlap
 * disappears. Tight pairs merge into one blob and stray serifs poke out of a
 * neighbour as unstroked white. Painting each glyph as its own stroked and
 * filled shape, left to right, keeps every letter's outline whole and lets
 * tight pairs read as layered -- which is what the reference does.
 */
function line(spec, originX, baselineY) {
	const mine = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
	const { chars, sizes, adv, width } = measure(spec);
	const t = rad(spec.tilt);
	const cos = Math.cos(t);
	const sin = Math.sin(t);
	let cursor = originX - width / 2;
	const out = [];
	chars.forEach((ch, i) => {
		// Centre the glyph on its own advance so its rotation turns it in place
		// rather than swinging it off the baseline.
		const half = (adv[i] - spec.track) / 2;
		const p = closeContours(font.charToGlyph(ch).getPath(-half, 0, sizes[i]));
		const j = rad(spec.rot?.[i] ?? 0);
		const jc = Math.cos(j);
		const js = Math.sin(j);
		const cx = cursor + half;
		const cy = baselineY + (spec.dy?.[i] ?? 0);
		mapPath(p, (x, y) => {
			// rotate about the glyph's own origin, place it on its own offset
			// baseline, then tilt the whole line about the lockup origin.
			const rx = x * jc - y * js + cx;
			const ry = x * js + y * jc + cy;
			const fx = rx * cos - ry * sin;
			const fy = rx * sin + ry * cos;
			grow(box, fx, fy);
			grow(mine, fx, fy);
			return [q(fx), q(fy)];
		});
		out.push(p.toPathData(1));
		cursor += adv[i];
	});
	return { parts: out, box: mine, width };
}

const web = measure(LINES[1]);
const gap = LEAD * CAP * LINES[1].size;
const capnLine = line(LINES[0], INDENT * web.width, -gap);
const webLine = line(LINES[1], 0, 0);
const CAPN_PATHS = capnLine.parts;
const WEB_PATHS = webLine.parts;

const pad = STROKE / 2 + 1;
const VIEWBOX = [
	q(box.x0 - pad),
	q(box.y0 - pad),
	q(box.x1 - box.x0 + pad * 2),
	q(box.y1 - box.y0 + pad * 2),
].join(' ');

/** A regular star of `points` points, outer radius 100, as SVG path data. */
function star(points, ratio, offsetDeg) {
	const d = [];
	for (let k = 0; k < points * 2; k++) {
		const r = 100 * (k % 2 ? ratio : 1);
		const a = rad(offsetDeg) + (k * Math.PI) / points;
		d.push(`${k ? 'L' : 'M'}${q(Math.cos(a) * r)} ${q(Math.sin(a) * r)}`);
	}
	return `${d.join('')}Z`;
}

/*
 * The seal. capnproto.org's is a perfectly regular 20-point star -- the peaks in
 * `infinitely_faster.png` land on exact 18 degree centres -- so this one is too.
 * An earlier version jittered the points on the theory that a printed seal would
 * be irregular; the reference says otherwise.
 */
const STAR_PATH = star(20, 0.81, 8.8);

/*
 * The favicon is the same seal with the detail taken out of it. At 16px a
 * 20-point star with an inner radius of 0.81 is a circle with a fuzzy edge: the
 * points are two pixels long and antialiasing eats them. Sixteen deeper points
 * survive the downsample and still read as the same object at 180px.
 *
 * The ratio is tuned for 32 physical pixels, not 16: a HiDPI tab strip asks for
 * the icon at 2x, and that is where the star stops being a bumpy disc and
 * resolves into points. Ratios were swept at 16/20/24/32/64 on both tab strips;
 * below about 0.5 the star keeps its points but loses so much ink that the 16px
 * rendering reads as a faint sparkle rather than a stamped seal.
 *
 * Eleven is an odd count, so the offset is zero and a point aims straight up
 * with a flat-ish valley opposite it. An even count centred a point top and
 * bottom and read as a cog.
 */
const FAVICON_POINTS = 11;
const FAVICON_RATIO = 0.55;
const FAVICON_STAR = star(FAVICON_POINTS, FAVICON_RATIO, 0);
/* `--cw-orange`, spelled out: a favicon is its own document and gets no page
   custom properties. Keep in step with `globals.css`. */
const FAVICON_FILL = '#e85d2c';

const paths = `// GENERATED -- do not hand-edit. Run \`scripts/build-wordmark.mjs\`.
// See README, "The wordmark".
//
// Outlines converted from TeX Gyre Bonum Bold (GUST Font License), a Bookman
// clone. Converted rather than set as live text on purpose: a logo that falls
// back to Georgia while a webfont loads is not a logo. Nothing here needs a
// font at runtime.
//
// Coordinates are in the space of capnproto.org's own \`logo.png\` -- 635 units
// across -- because that is what the mark parodies and what it was measured
// against.

// One entry per glyph, in painting order. See the note in the build script:
// merging them into one path per line loses the keyline wherever two letters
// touch.

/** CAP'N, tilted, sitting above and right of centre over WEB. */
export const CAPN_PATHS: readonly string[] = [
${CAPN_PATHS.map((d) => `\t'${d}',`).join('\n')}
];

/** WEB, tilted a little further, with an oversized initial. */
export const WEB_PATHS: readonly string[] = [
${WEB_PATHS.map((d) => `\t'${d}',`).join('\n')}
];

/** Tight viewBox for the tilted lockup, with room for the outermost stroke. */
export const LOCKUP_VIEWBOX = '${VIEWBOX}';

/** Stroke width for the black keyline, in the same units. Half shows, outside
 *  the fill, under \`paint-order: stroke\`. */
export const LOCKUP_STROKE = ${STROKE};

/** A regular 20-point seal on a 100 radius about the origin. */
export const STAR_PATH = '${STAR_PATH}';

/** The seal's own square viewBox, with room for the points. */
export const STAR_VIEWBOX = '-104 -104 208 208';
`;

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-104 -104 208 208">
<title>Cap'n Web</title>
<path d="${FAVICON_STAR}" fill="${FAVICON_FILL}"/>
</svg>
`;

const dest = new URL('../src/components/logo-paths.ts', import.meta.url);
const fav = new URL('../public/favicon.svg', import.meta.url);
fs.writeFileSync(dest, paths);
fs.writeFileSync(fav, favicon);

console.error(
	`wrote ${dest.pathname}\n` +
		`      ${fav.pathname}\n` +
		`  lockup viewBox ${VIEWBOX}\n` +
		`  CAP'N ${CAPN_PATHS.length} glyphs ${CAPN_PATHS.join('').length}b  ` +
		`WEB ${WEB_PATHS.length} glyphs ${WEB_PATHS.join('').length}b\n` +
		`  CAP'N box x ${q(capnLine.box.x0)}..${q(capnLine.box.x1)}  y ${q(capnLine.box.y0)}..${q(capnLine.box.y1)}\n` +
		`  WEB   box x ${q(webLine.box.x0)}..${q(webLine.box.x1)}  y ${q(webLine.box.y0)}..${q(webLine.box.y1)}\n` +
		`  vertical clearance (WEB top under CAP'N bottom): ${q(webLine.box.y0 - capnLine.box.y1)}\n` +
		`  cap/em ${q(CAP * 1000) / 1000}  baseline gap ${q(gap)}\n` +
		`  favicon ${FAVICON_POINTS} points, inner/outer ${FAVICON_RATIO}`,
);
