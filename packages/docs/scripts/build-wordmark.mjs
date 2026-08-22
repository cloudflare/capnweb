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

/*
 * The third output: the banner at the top of the repo's root README, which is
 * also what npm renders on the package page.
 *
 * This cannot lean on CSS -- no custom properties, no `prefers-color-scheme`,
 * no theme attribute -- and it has to look right on GitHub light, GitHub dark,
 * and npm, which now has a dark theme of its own. The usual answer is a
 * `<picture>` with a light and a dark file, but npm's markdown sanitiser is far
 * more aggressive than GitHub's and drops `<source>`, which would leave
 * dark-mode npm users looking at the light variant on a dark page.
 *
 * So the whole band -- gradient and both accents together -- is laid down at
 * `BAND_ALPHA`, and the page shows through it. On a white README it lifts to a
 * soft slate; on a dark one it settles almost to the site's own navy. That is
 * the point: an opaque band looks pasted on, identical on both themes and
 * matching neither.
 *
 * The alpha is high rather than subtle, and that is a legibility floor, not
 * timidity. The wordmark is white, so the band has to stay dark enough to carry
 * it whatever is behind. At 0.82 the band lands near rgb(55 62 74) over white
 * and rgb(11 19 32) over GitHub's dark -- clearly different, both far enough
 * from white to hold the mark. Taking it much lower washes the band out on a
 * light page and the wordmark goes with it.
 *
 * Only the seal breaks the edge of the band. It is the one element painted to
 * survive on an unknown background, so it gets the site's treatment: flat
 * orange, no keyline, and a soft drop shadow to lift it off whatever it lands
 * on. Below the band the canvas is fully transparent, so it reads as
 * overhanging a real edge.
 */
const BAND_ALPHA = 0.82;
const BAND_TOP_PAD = 58;
const BAND_BOTTOM_PAD = 55;
/* The lockup as a fraction of the banner's width. The band is much wider than
   the mark, the way a site header is, rather than shrink-wrapped to it. */
const LOCKUP_FRACTION = 0.34;
/* How much of the seal hangs below the band, as a fraction of its height. The
   reference overhangs 18.9%. */
const SEAL_OVERHANG = 0.19;
const SEAL_R = 87.5;
const SEAL_TILT = -11;
const SEAL_SCALE = SEAL_R / 100;

/*
 * The site's seal shadow is `drop-shadow(0 2px 3px rgb(0 0 0 / 0.32))` on a
 * seal 128px across. This one is 175 units across, so both numbers scale by
 * 175/128, and a CSS blur radius is twice a Gaussian's standard deviation.
 */
const SEAL_SHADOW_SCALE = (SEAL_R * 2) / 128;
const SEAL_SHADOW_DY = 2 * SEAL_SHADOW_SCALE;
const SEAL_SHADOW_BLUR = (3 / 2) * SEAL_SHADOW_SCALE;
/*
 * Where the seal's centre sits, across the lockup.
 *
 * The site puts it at 91.5%, but the site's seal hangs off a full-bleed banner
 * with the whole viewport to its right. Here the wordmark is the only thing on
 * the band, and at 91.5% the seal lands squarely on the `B` and the lower line
 * reads "WEE".
 */
const SEAL_AT = 1.0;

/*
 * Then the seal moves this much further right again, and the wordmark the same
 * distance left, which clears the `B` without shifting where the pair sits as a
 * whole. The `B` ends 459 units along a 512-unit mark and the seal's radius is
 * 87.5, so the two stop touching once the nudge passes about 17.
 */
const SEAL_NUDGE = 20;

const MARK_W = box.x1 - box.x0 + pad * 2;
const MARK_H = box.y1 - box.y0 + pad * 2;
const BAND_W = MARK_W / LOCKUP_FRACTION;
const BAND_H = MARK_H + BAND_TOP_PAD + BAND_BOTTOM_PAD;
const sealPad = (STROKE * SEAL_SCALE) / 2 + 1;

/*
 * Centre the mark and the seal together, not the mark alone. The seal sticks
 * out past the wordmark's right edge, so centring just the wordmark would leave
 * the whole assembly visibly sitting right of middle.
 */
const ASSEMBLY_W = Math.max(MARK_W, MARK_W * SEAL_AT + SEAL_NUDGE + SEAL_R + sealPad);
const MARK_LEFT = (BAND_W - ASSEMBLY_W) / 2;

/* Put the lockup's own coordinates into the banner's. */
const OX = MARK_LEFT - SEAL_NUDGE - (box.x0 - pad);
const OY = BAND_TOP_PAD - (box.y0 - pad);

const SEAL_CX = MARK_LEFT + MARK_W * SEAL_AT + SEAL_NUDGE;
const SEAL_CY = BAND_H - SEAL_R + SEAL_OVERHANG * SEAL_R * 2;
const CANVAS_H = SEAL_CY + SEAL_R + sealPad + 4;

/*
 * A CSS `linear-gradient(Ndeg, ...)` as SVG gradient endpoints.
 *
 * CSS measures the angle clockwise from "to top"; the gradient line runs
 * through the centre of the box and is long enough that the stops at 0% and
 * 100% land on the corners, which is `|w*sin| + |h*cos|`.
 */
function cssLinear(deg, w, h) {
	const t = rad(deg);
	const dx = Math.sin(t);
	const dy = -Math.cos(t);
	const len = Math.abs(w * dx) + Math.abs(h * dy);
	return {
		x1: q(w / 2 - (dx * len) / 2),
		y1: q(h / 2 - (dy * len) / 2),
		x2: q(w / 2 + (dx * len) / 2),
		y2: q(h / 2 + (dy * len) / 2),
	};
}

/*
 * A CSS `radial-gradient(RX RY at CX CY, colour 0%, transparent STOP%)`.
 *
 * SVG radial gradients are circles, so the ellipse is a circle of `rx` scaled
 * on y about its own centre. The far stop repeats the colour at zero alpha
 * rather than using `transparent`: fading to `transparent` fades towards
 * transparent *black*, which greys the accent on its way out.
 */
function cssRadial(id, colour, alpha, rxF, ryF, cxF, cyF, stop, w, h) {
	const cx = q(cxF * w);
	const cy = q(cyF * h);
	const rx = rxF * w;
	const sy = q((ryF * h) / rx);
	return (
		`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${q(rx)}"\n` +
		`                gradientTransform="translate(${cx} ${cy}) scale(1 ${sy}) translate(${-cx} ${-cy})">\n` +
		`<stop offset="0" stop-color="${colour}" stop-opacity="${alpha}"/>\n` +
		`<stop offset="${stop}" stop-color="${colour}" stop-opacity="0"/>\n` +
		`</radialGradient>`
	);
}

const lin = cssLinear(104, BAND_W, BAND_H);

/** Lays out one line of plain text, centred on x=0, as a single path.
 *  Fill-only, so unlike the wordmark it does not need a path per glyph. */
function plain(text, size, baselineY) {
	const width = font.getAdvanceWidth(text, size);
	return closeContours(font.getPath(text, -width / 2, baselineY, size)).toPathData(1);
}

/*
 * The seal's legend. On the site these words are real DOM text so they stay
 * selectable and translatable; here there is no DOM and no webfont, so they are
 * outlined. That costs nothing and buys back the fidelity the site gives up --
 * these are Bookman, the same face as the wordmark, which the site cannot
 * manage without shipping a font for three words.
 *
 * `HERO_TITLE`, lower-cased and broken the way the seal breaks it.
 */
const LEGEND = ['one', 'round', 'trip!'];

/*
 * Sized to the star's flat inner disc (radius 81 of 100), against both of the
 * constraints a circle imposes: the widest line has to fit across it, and the
 * stack of lines has to fit down it. With three short lines the height is what
 * binds, where with two longer ones the width did.
 */
const LEGEND_FIT = 81 * 2 * 0.82;
const LEGEND_LEAD_RATIO = 1.04;
const LEGEND_SIZE = Math.min(
	LEGEND_FIT / Math.max(...LEGEND.map((l) => font.getAdvanceWidth(l, 1))),
	LEGEND_FIT / ((LEGEND.length - 1) * LEGEND_LEAD_RATIO + CAP),
);
const LEGEND_LEAD = LEGEND_SIZE * LEGEND_LEAD_RATIO;
const legendPaths = LEGEND.map((text, i) =>
	plain(text, LEGEND_SIZE, (i - (LEGEND.length - 1) / 2) * LEGEND_LEAD + (CAP * LEGEND_SIZE) / 2),
);

/* 2x what the README displays it at, so it stays sharp on a HiDPI screen. */
const BANNER_W = 1600;

const banner = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${q(BAND_W)} ${q(CANVAS_H)}"
     width="${BANNER_W}" height="${Math.round((BANNER_W * CANVAS_H) / BAND_W)}"
     role="img" aria-label="Cap'n Web">
<title>Cap'n Web</title>
<defs>
<linearGradient id="band" gradientUnits="userSpaceOnUse"
                x1="${lin.x1}" y1="${lin.y1}" x2="${lin.x2}" y2="${lin.y2}">
<stop offset="0" stop-color="#0a1424"/>
<stop offset="0.54" stop-color="#0c1c2b"/>
<stop offset="1" stop-color="#0a2320"/>
</linearGradient>
${cssRadial('glow1', '#7aa2ff', 0.13, 0.72, 1.2, 0.12, 0, 0.62, BAND_W, BAND_H)}
${cssRadial('glow2', '#4fd6a8', 0.12, 0.66, 1.18, 0.9, 1.04, 0.6, BAND_W, BAND_H)}
<filter id="sealshadow" x="-15%" y="-15%" width="140%" height="140%">
<feDropShadow dx="0" dy="${q(SEAL_SHADOW_DY)}" stdDeviation="${q(SEAL_SHADOW_BLUR)}"
              flood-color="#000" flood-opacity="0.32"/>
</filter>
</defs>
<!-- The band is one translucent group, so the accents keep their relationship
     to the gradient and the page shows through all three together. -->
<g opacity="${BAND_ALPHA}">
<rect width="${q(BAND_W)}" height="${q(BAND_H)}" fill="url(#band)"/>
<rect width="${q(BAND_W)}" height="${q(BAND_H)}" fill="url(#glow1)"/>
<rect width="${q(BAND_W)}" height="${q(BAND_H)}" fill="url(#glow2)"/>
</g>
<g transform="translate(${q(OX)} ${q(OY)})" fill="#fff" stroke="#070a11"
   stroke-width="${STROKE}" stroke-linejoin="round" paint-order="stroke fill">
${[...CAPN_PATHS, ...WEB_PATHS].map((d) => `<path d="${d}"/>`).join('\n')}
</g>
<g transform="translate(${q(SEAL_CX)} ${q(SEAL_CY)})">
<!-- The shadow goes on a wrapper rather than the path: on the path itself the
     filter would resolve in the rotated, scaled space and the shadow would come
     out tilted and undersized. The legend sits outside it, unshadowed, exactly
     as the site keeps the filter off the words. -->
<g filter="url(#sealshadow)">
<path d="${STAR_PATH}" transform="rotate(${SEAL_TILT}) scale(${q(SEAL_SCALE)})" fill="#e85d2c"/>
</g>
${legendPaths.map((d) => `<path d="${d}" fill="#070a11"/>`).join('\n')}
</g>
</svg>
`;

/*
 * The fourth and fifth outputs: art for the social cards.
 *
 * The cards themselves are drawn per page by `astro-og-canvas` (34 of them, one
 * per title), and that stays as it is -- it rasterises with canvaskit and wants
 * no browser at build time. What it cannot do is draw this band: it takes a
 * list of gradient stops, and the band is a linear gradient with two elliptical
 * accents over it. So the band is handed to it as a finished `bgImage`, and the
 * mark as a `logo`, both generated here from the same geometry as the README
 * banner. That keeps one source of truth without a browser in the docs build.
 *
 * The band is opaque here, unlike the README's. A social card is composited by
 * Slack or a search engine onto a surface this repository does not control and
 * cannot measure, and a translucent one would come out differently in each. The
 * README can adapt to its page because there are only two of those and both are
 * known.
 */
const OG_W = 1200;
const OG_H = 630;
/*
 * The orange edge is painted into the band rather than left to the card's own
 * `border` option, because a `bgImage` is drawn over that border and hides it.
 * The option stays set in `_og-card-config.ts` at this same width, so the
 * fallback path -- gradient with no image -- still gets an edge.
 */
const OG_BORDER = 12;
const ogLin = cssLinear(104, OG_W, OG_H);

const ogBand = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${OG_W} ${OG_H}"
     width="${OG_W}" height="${OG_H}">
<defs>
<linearGradient id="band" gradientUnits="userSpaceOnUse"
                x1="${ogLin.x1}" y1="${ogLin.y1}" x2="${ogLin.x2}" y2="${ogLin.y2}">
<stop offset="0" stop-color="#0a1424"/>
<stop offset="0.54" stop-color="#0c1c2b"/>
<stop offset="1" stop-color="#0a2320"/>
</linearGradient>
${cssRadial('glow1', '#7aa2ff', 0.13, 0.72, 1.2, 0.12, 0, 0.62, OG_W, OG_H)}
${cssRadial('glow2', '#4fd6a8', 0.12, 0.66, 1.18, 0.9, 1.04, 0.6, OG_W, OG_H)}
</defs>
<rect width="${OG_W}" height="${OG_H}" fill="url(#band)"/>
<rect width="${OG_W}" height="${OG_H}" fill="url(#glow1)"/>
<rect width="${OG_W}" height="${OG_H}" fill="url(#glow2)"/>
<rect width="${OG_BORDER}" height="${OG_H}" fill="#e85d2c"/>
</svg>
`;

/*
 * The mark on its own, transparent, holding the same seal placement the banner
 * uses. Keeping the relationship identical means the two read as one object:
 * in the banner the mark moves left by `SEAL_NUDGE` and the seal right by the
 * same, so here the seal sits `MARK_W * SEAL_AT + 2 * SEAL_NUDGE` along.
 */
const ogSealCx = box.x0 - pad + MARK_W * SEAL_AT + 2 * SEAL_NUDGE;
const ogSealCy = box.y0 - pad + (SEAL_CY - BAND_TOP_PAD);
const ogShadowPad = SEAL_SHADOW_DY + SEAL_SHADOW_BLUR * 3;
const mb = {
	x0: Math.min(box.x0 - pad, ogSealCx - SEAL_R - ogShadowPad),
	y0: Math.min(box.y0 - pad, ogSealCy - SEAL_R - ogShadowPad),
	x1: Math.max(box.x1 + pad, ogSealCx + SEAL_R + ogShadowPad),
	y1: Math.max(box.y1 + pad, ogSealCy + SEAL_R + ogShadowPad),
};

const ogMark = `<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="${q(mb.x0)} ${q(mb.y0)} ${q(mb.x1 - mb.x0)} ${q(mb.y1 - mb.y0)}"
     width="${Math.round(mb.x1 - mb.x0)}" height="${Math.round(mb.y1 - mb.y0)}"
     role="img" aria-label="Cap'n Web">
<title>Cap'n Web</title>
<defs>
<filter id="sealshadow" x="-15%" y="-15%" width="140%" height="140%">
<feDropShadow dx="0" dy="${q(SEAL_SHADOW_DY)}" stdDeviation="${q(SEAL_SHADOW_BLUR)}"
              flood-color="#000" flood-opacity="0.32"/>
</filter>
</defs>
<g fill="#fff" stroke="#070a11" stroke-width="${STROKE}" stroke-linejoin="round"
   paint-order="stroke fill">
${[...CAPN_PATHS, ...WEB_PATHS].map((d) => `<path d="${d}"/>`).join('\n')}
</g>
<g transform="translate(${q(ogSealCx)} ${q(ogSealCy)})">
<g filter="url(#sealshadow)">
<path d="${STAR_PATH}" transform="rotate(${SEAL_TILT}) scale(${q(SEAL_SCALE)})" fill="#e85d2c"/>
</g>
${legendPaths.map((d) => `<path d="${d}" fill="#070a11"/>`).join('\n')}
</g>
</svg>
`;

const dest = new URL('../src/components/logo-paths.ts', import.meta.url);
const fav = new URL('../public/favicon.svg', import.meta.url);
const bnr = new URL('../../../assets/capnweb-banner.svg', import.meta.url);
fs.writeFileSync(dest, paths);
fs.writeFileSync(fav, favicon);
fs.mkdirSync(new URL('../../../assets/', import.meta.url), { recursive: true });
fs.writeFileSync(bnr, banner);
fs.mkdirSync(new URL('../og-assets/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../og-assets/og-band.svg', import.meta.url), ogBand);
fs.writeFileSync(new URL('../og-assets/og-mark.svg', import.meta.url), ogMark);

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
		`  favicon ${FAVICON_POINTS} points, inner/outer ${FAVICON_RATIO}\n` +
		`  banner ${q(BAND_W)}x${q(CANVAS_H)} units, band ${q(BAND_H)}, ` +
		`seal overhangs ${q(SEAL_OVERHANG * 100)}%`,
);
