import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the repo root by walking up until two sentinels are both present.
 *
 * Deriving it from a fixed number of `..` segments does not work: for a
 * production build this module is bundled into `dist/.prerender/chunks/`, so
 * `import.meta.url` points somewhere else entirely and the offset silently
 * changes. `process.cwd()` is also not dependable, since the docs are built
 * both from this directory and from the repo root via `npm --prefix`.
 *
 * Searching for the sentinels handles every one of those cases. Requiring two
 * of them makes a false positive effectively impossible.
 */
function findRepoRoot(): string {
	const sentinels = ['examples', join('packages', 'docs', 'astro.config.ts')];
	const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];

	for (const start of starts) {
		let dir = resolve(start);
		for (;;) {
			if (sentinels.every((sentinel) => existsSync(join(dir, sentinel)))) return dir;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	throw new Error(
		`Could not locate the capnweb repo root from ${starts.join(' or ')}. ` +
			`Looked for a directory containing: ${sentinels.join(' and ')}.`,
	);
}

let cachedRoot: string | undefined;

function repoRoot(): string {
	return (cachedRoot ??= findRepoRoot());
}

/**
 * Read a file from the repo, given a path relative to the repo root.
 *
 * The example playgrounds render straight from the real source files, so the
 * code on the site cannot drift from the code that is actually deployed. That
 * only holds if a missing file is a hard error -- silently rendering an empty
 * tab would defeat the point -- so this throws and fails the build.
 */
export function readRepoFile(relativePath: string): string {
	const absolute = join(repoRoot(), relativePath);
	let contents: string;
	try {
		contents = readFileSync(absolute, 'utf8');
	} catch (cause) {
		throw new Error(
			`Cannot read example source "${relativePath}" (resolved to ${absolute}). ` +
				`Playground file lists live in src/examples.ts; update them if a file moved.`,
			{ cause },
		);
	}
	// Trim trailing blank lines so the code frame has no dead space at the end.
	return `${contents.replace(/\s+$/, '')}\n`;
}
