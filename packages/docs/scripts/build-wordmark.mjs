/*
 * Regenerates `src/components/logo-paths.ts`, the Cap'n Web wordmark geometry.
 *
 * Not part of the build: it runs when the mark itself changes, which is close to
 * never, and it needs a font file and `opentype.js` that the site does not
 * otherwise depend on. Committed so the next person to want a different arch,
 * size or tracking can change a number here instead of reverse-engineering path
 * data.
 *
 *   npm i opentype.js
 *   curl -o alfa.ttf https://fonts.gstatic.com/s/alfaslabone/v21/6NUQ8FmMKwSEKjnm5-4v-4Jh6dU.ttf
 *   node scripts/build-wordmark.mjs > /dev/null
 *
 * Letterforms are Alfa Slab One (SIL OFL 1.1). Converting glyphs to outlines is
 * ordinary use of a font; only the resulting paths ship.
 */
import opentype from 'opentype.js';
import fs from 'node:fs';

const font = opentype.parse(fs.readFileSync(new URL('./alfa.ttf', import.meta.url)).buffer);
/*
 * Coordinate precision, per use.
 *
 * The nav mark is ~715 units wide rendered at about 90px, so one unit is a
 * ninth of a pixel and two decimals of it is noise that ships on every page.
 * The hero is ~767 units at ~610px, so a unit is 0.8px there and integers
 * would be visible on the curves. Different jobs, different rounding.
 */
const q = (n, dp) => { const f = 10 ** dp; return Math.round(n * f) / f; };
let DP = 2;
const r2 = (n) => q(n, DP);

function arcText(text, { size, radius, tracking = 0 }) {
	const glyphs = [...text].map((ch) => font.charToGlyph(ch));
	const scale = size / font.unitsPerEm;
	const adv = glyphs.map((g) => g.advanceWidth * scale + tracking);
	const total = adv.reduce((a, b) => a + b, 0);
	let cursor = -total / 2;
	const parts = [];
	const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
	const see = (x, y) => {
		box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y);
		box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y);
	};
	glyphs.forEach((glyph, i) => {
		const mid = cursor + adv[i] / 2;
		cursor += adv[i];
		const a = mid / radius, ox = radius * Math.sin(a), oy = radius - radius * Math.cos(a);
		const cos = Math.cos(a), sin = Math.sin(a);
		const p = glyph.getPath(-adv[i] / 2 + tracking / 2, 0, size);
		const m = (x, y) => { const nx = x * cos - y * sin + ox, ny = x * sin + y * cos + oy; see(nx, ny); return [r2(nx), r2(ny)]; };
		for (const c of p.commands) {
			if (c.type === 'M' || c.type === 'L') parts.push(c.type + m(c.x, c.y).join(' '));
			else if (c.type === 'C') parts.push('C' + [m(c.x1, c.y1), m(c.x2, c.y2), m(c.x, c.y)].flat().join(' '));
			else if (c.type === 'Q') parts.push('Q' + [m(c.x1, c.y1), m(c.x, c.y)].flat().join(' '));
			else if (c.type === 'Z') parts.push('Z');
		}
	});
	return { d: parts.join(''), box };
}

function starburst({ points = 22, outer = 100, inner = 80, seed = 7 }) {
	let s = seed;
	const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
	const pts = [];
	for (let i = 0; i < points * 2; i++) {
		const r = (i % 2 === 0 ? outer : inner) * (1 + rnd() * 0.04);
		const a = (Math.PI * i) / points - Math.PI / 2 + rnd() * 0.014;
		pts.push(`${r2(Math.cos(a) * r)} ${r2(Math.sin(a) * r)}`);
	}
	return 'M' + pts.join('L') + 'Z';
}

// --- the hero lockup: CAP'N arched over a much larger WEB --------------------
const CY = -40, WY = 215, TILT = -3.5;
DP = 1;
const capn = arcText("CAP'N", { size: 118, radius: 520, tracking: 2 });
const web = arcText('WEB', { size: 232, radius: 900, tracking: 8 });

// Union box in lockup space, before the tilt, plus room for the fattest stroke.
const PAD = 22;
const bx0 = Math.min(capn.box.x0, web.box.x0) - PAD;
const bx1 = Math.max(capn.box.x1, web.box.x1) + PAD;
const by0 = Math.min(capn.box.y0 + CY, web.box.y0 + WY) - PAD;
const by1 = Math.max(capn.box.y1 + CY, web.box.y1 + WY) + PAD;
// The tilt rotates the box about the origin, so grow it to the rotated extent.
const t = (TILT * Math.PI) / 180, ct = Math.cos(t), st = Math.sin(t);
let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
for (const [x, y] of [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]]) {
	const nx = x * ct - y * st, ny = x * st + y * ct;
	rx0 = Math.min(rx0, nx); ry0 = Math.min(ry0, ny);
	rx1 = Math.max(rx1, nx); ry1 = Math.max(ry1, ny);
}

// --- the nav miniature: one gently arched line, legible at 26px -------------
DP = 0;
const oneLine = arcText("CAP'N WEB", { size: 100, radius: 1500, tracking: 3 });
const NPAD = 16;
const nb = oneLine.box;

const out = `// GENERATED -- do not hand-edit. See README, "The wordmark".
//
// Outlines converted from Alfa Slab One (SIL OFL 1.1) by /tmp/opencode/logo/build.mjs.
// Converted rather than set as live text on purpose: a logo that falls back to
// Georgia while a webfont loads is not a logo. Nothing here needs a font at
// runtime.

/** CAP'N, arched, sitting above WEB in the hero lockup. */
export const CAPN_PATH = '${capn.d}';
/** WEB, arched more gently because it is twice the size and would otherwise bend. */
export const WEB_PATH = '${web.d}';
/** Where each line sits, and the tilt of the whole lockup. */
export const LOCKUP = { capnY: ${CY}, webY: ${WY}, tilt: ${TILT} } as const;
/** Tight viewBox for the tilted lockup, with room for the outermost stroke. */
export const LOCKUP_VIEWBOX = '${r2(rx0)} ${r2(ry0)} ${r2(rx1 - rx0)} ${r2(ry1 - ry0)}';

/** One-line CAP'N WEB for the site header, where two arched lines would be mush. */
export const ONELINE_PATH = '${oneLine.d}';
export const ONELINE_VIEWBOX = '${r2(nb.x0 - NPAD)} ${r2(nb.y0 - NPAD)} ${r2(nb.x1 - nb.x0 + NPAD * 2)} ${r2(nb.y1 - nb.y0 + NPAD * 2)}';

/**
 * A 22-point seal, drawn on a 100 radius about the origin.
 *
 * The per-point jitter is deliberate: a perfectly regular star reads as a UI
 * widget out of a component library, and the printed seals this is imitating
 * were cut by hand. The irregularity is most of why it looks stamped on.
 */
export const STAR_PATH = '${starburst({})}';
`;
fs.writeFileSync(new URL('../src/components/logo-paths.ts', import.meta.url), out);
console.log('lockup viewBox', `${r2(rx0)} ${r2(ry0)} ${r2(rx1 - rx0)} ${r2(ry1 - ry0)}`);
console.log('oneline viewBox', `${r2(nb.x0 - NPAD)} ${r2(nb.y0 - NPAD)} ${r2(nb.x1 - nb.x0 + NPAD * 2)} ${r2(nb.y1 - nb.y0 + NPAD * 2)}`);
console.log('bytes', out.length);
