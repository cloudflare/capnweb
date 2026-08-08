/**
 * Regenerates the subset fonts used by the social cards.
 *
 * The cards are rasterized at build time by `src/lib/og-card.ts`, which needs
 * real font data -- Satori has to measure glyphs to break lines. Shipping the
 * full Inter family would be ~800 kB of binary in the repo for text that only
 * ever renders a page title, so we commit a subset of about 80 kB per weight.
 *
 * Nothing here runs during a normal build. Run it only when the character set
 * changes, i.e. when a page title introduces a glyph the subset lacks. The
 * symptom of that is a blank box in the rendered card.
 *
 * Usage:
 *   1. Download Inter (SIL OFL 1.1) from https://github.com/rsms/inter/releases
 *   2. unzip it somewhere
 *   3. node scripts/build-og-fonts.mjs <path-to-unzipped-inter>
 */
import fs from 'node:fs';
import path from 'node:path';
import subsetFont from 'subset-font';

/**
 * The glyphs the cards can draw: printable ASCII, plus the punctuation our
 * titles and descriptions actually use. Keep this in sync with reality rather
 * than making it exhaustive -- every added range costs bytes.
 */
const CHARS =
	Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') +
	'\u2014' + // em dash
	'\u2013' + // en dash
	'\u2018\u2019' + // curly single quotes
	'\u201c\u201d' + // curly double quotes
	'\u00d7' + // multiplication sign
	'\u00b7' + // middle dot
	'\u2026' + // ellipsis
	'\u00a0' + // non-breaking space
	'\u2192'; // right arrow

const WEIGHTS = [
	['Inter-Regular.ttf', 'inter-regular-subset.ttf'],
	['Inter-SemiBold.ttf', 'inter-semibold-subset.ttf'],
];

const source = process.argv[2];
if (!source) {
	console.error('Usage: node scripts/build-og-fonts.mjs <path-to-unzipped-inter>');
	console.error('Download from https://github.com/rsms/inter/releases');
	process.exit(1);
}

const outDir = new URL('../src/assets/fonts/', import.meta.url);
fs.mkdirSync(outDir, { recursive: true });

for (const [from, to] of WEIGHTS) {
	// Inter ships static TTFs under extras/ttf; accept a direct directory too.
	const candidates = [path.join(source, 'extras/ttf', from), path.join(source, from)];
	const found = candidates.find((candidate) => fs.existsSync(candidate));
	if (!found) {
		console.error(`Could not find ${from}. Looked in:\n  ${candidates.join('\n  ')}`);
		process.exit(1);
	}

	const original = fs.readFileSync(found);
	const subset = await subsetFont(original, CHARS, { targetFormat: 'truetype' });
	fs.writeFileSync(new URL(to, outDir), subset);

	const kb = (bytes) => `${(bytes / 1024).toFixed(0)} kB`;
	console.log(`${to}  ${kb(original.length)} -> ${kb(subset.length)}`);
}

console.log('\nRemember to keep Inter-LICENSE.txt alongside the subsets (SIL OFL 1.1).');
