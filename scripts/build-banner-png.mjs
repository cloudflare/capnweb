/*
 * Rasterises `assets/capnweb-banner.svg` to `assets/capnweb-banner.png`.
 *
 *   node scripts/build-banner-png.mjs
 *
 * The README ships the PNG rather than the SVG, and the reason is npm. GitHub
 * renders SVG in a README happily, and `raw.githubusercontent` even serves it
 * as `image/svg+xml` rather than `text/plain`, so SVG would very likely work
 * there too -- but "very likely" is the problem. npm's markdown pipeline
 * sanitises harder than GitHub's, and the package page is the first thing most
 * people see. A PNG has no sanitiser story at all. The SVG stays in the repo as
 * the source this is generated from, and for anywhere the vector is wanted.
 *
 * Regenerate the SVG first, with `packages/docs/scripts/build-wordmark.mjs`.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * Three images, one browser. Two of them belong to the docs package rather than
 * the root, and are written across the boundary on purpose: `playwright` and
 * `sharp` are declared here, and `packages/docs` is deliberately outside the
 * npm workspaces with its own lockfile, so a script living there could only
 * reach these by hoisting. The generator already crosses the other way.
 */
const JOBS = [
	{
		svg: '../assets/capnweb-banner.svg',
		png: '../assets/capnweb-banner.png',
		what: 'the README banner, translucent',
	},
	{
		svg: '../packages/docs/og-assets/og-band.svg',
		png: '../packages/docs/og-assets/og-band.png',
		what: 'social card background, opaque',
	},
	{
		svg: '../packages/docs/og-assets/og-mark.svg',
		png: '../packages/docs/og-assets/og-mark.png',
		what: 'social card logo, transparent',
	},
];

for (const job of JOBS) {
	const p = new URL(job.svg, import.meta.url);
	if (!fs.existsSync(p)) {
		throw new Error(
			`${fileURLToPath(p)} is missing.\n` +
				'Generate the SVGs first:\n' +
				'  cd packages/docs && node scripts/build-wordmark.mjs <path-to-texgyrebonum-bold.otf>',
		);
	}
}

const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
	args: ['--no-sandbox'],
});
const page = await browser.newPage();

for (const job of JOBS) {
	const src = new URL(job.svg, import.meta.url);
	const out = fileURLToPath(new URL(job.png, import.meta.url));

	/* The SVG is inlined into the document rather than loaded through an <img>:
	   an <img> would need a file:// URL, which the page is not allowed to fetch. */
	await page.setContent(
		`<!doctype html><style>html,body{margin:0;padding:0;background:transparent}</style>` +
			fs.readFileSync(src, 'utf8'),
	);

	/* `omitBackground` is what leaves the area below the band -- and every pixel
	   the seal does not cover -- genuinely transparent rather than white. */
	const shot = await page.locator('svg').screenshot({ omitBackground: true });

	/*
	 * Re-encode before writing. Chrome's PNG encoder is tuned for speed and
	 * leaves most of the compression on the table: the banner goes 376 kB -> 98 kB.
	 *
	 * `palette: true` is set on purpose, and it is worth being clear that this is
	 * lossy -- sharp will also quantise silently if you pass `effort` without
	 * `palette`, which reads as lossless and is not.
	 *
	 * Quantising an image that is mostly smooth gradient normally shows up as
	 * banding, and it does not here for a slightly perverse reason: Chrome
	 * already dithers the gradient when it rasterises, so the source carries
	 * dither noise of its own. That noise is what makes the file big, and it is
	 * also what hides the palette. Measured against a lossless encode of the
	 * banner, no pixel with alpha at or above 200 differs by more than 12/255,
	 * and 228 pixels out of 803,200 differ in alpha at all.
	 *
	 * If the artwork ever loses that gradient, re-check this: on genuinely flat
	 * colour a palette would band where the source has no noise to hide behind.
	 */
	await sharp(shot).png({ palette: true, quality: 100, effort: 10, compressionLevel: 9 }).toFile(out);

	const b = fs.readFileSync(out);
	console.error(
		`wrote ${out}\n` +
			`  ${b.readUInt32BE(16)}x${b.readUInt32BE(20)}, ` +
			`${(b.length / 1024).toFixed(1)} kB -- ${job.what}`,
	);
}

await browser.close();
