/**
 * Measures how big Cap'n Web actually is, so the docs can stop asserting it from memory.
 *
 * The site claims a size in several places, including two frontmatter strings and a card on the
 * landing page. Those were written when the number was "under 10 kB" and were wrong by the time
 * anyone noticed, which is the usual fate of a number typed into prose. This computes it during
 * `prebuild` and writes it where the remark plugin and the Astro config can read it.
 *
 * The number is minify + gzip of the browser entry point, which is what a reader comparing
 * libraries expects: what lands in a bundle, compressed the way a server would send it. Brotli is
 * recorded too, since that is what most connections actually negotiate, but the headline stays
 * gzip because that is the conservative figure and the one everyone else quotes.
 */

import { build } from 'esbuild';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const out = resolve(here, '../src/generated/bundle-size.json');

// Bundled from source rather than from `dist/`, so this works in a clean checkout and never
// reports a stale number left over from an older build of the library.
const result = await build({
	entryPoints: [resolve(repoRoot, 'src/index.ts')],
	bundle: true,
	minify: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	write: false,
	logLevel: 'error',
});

const minified = result.outputFiles[0].contents;
const gzip = gzipSync(minified, { level: 9 }).length;
const brotli = brotliCompressSync(minified).length;

// Round up to the next whole kB. "Under 16 kB" has to stay true as the library drifts upward
// within a kilobyte, and a claim that rounds down would go stale between releases.
const kb = Math.ceil(gzip / 1024);

const data = {
	minifiedBytes: minified.length,
	gzipBytes: gzip,
	brotliBytes: brotli,
	kb,
	/** The form used in prose, e.g. "under 16 kB". */
	label: `under ${kb} kB`,
	measuredAt: new Date().toISOString(),
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(data, null, '\t')}\n`);

console.log(
	`[bundle-size] minified ${minified.length} B, gzip ${gzip} B, brotli ${brotli} B -> "${data.label}"`
);
