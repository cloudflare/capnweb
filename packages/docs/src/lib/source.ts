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
	const sentinels = ['examples', join('packages', 'docs', 'astro.config.mjs')];
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

/**
 * Extract a named `#region` from a repo file.
 *
 * Some sources are far too long to show whole -- the demo page is mostly CSS,
 * for instance -- but hard-coded line numbers would silently start showing the
 * wrong lines the moment anything above them changed. Named regions move with
 * the code they wrap, and are the same `#region` markers editors already fold
 * on, so they survive edits. A missing marker is a build error, like a missing
 * file.
 *
 * The marker lines themselves are dropped, and the common indentation is
 * removed so the snippet does not render with a deep left margin.
 */
export function readRepoRegion(relativePath: string, region: string): string {
	const lines = readRepoFile(relativePath).split('\n');
	// Matches `#region name` / `#endregion` inside any comment syntax.
	const startPattern = new RegExp(`#region\\s+${region.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
	const start = lines.findIndex((line) => startPattern.test(line));
	if (start === -1) {
		throw new Error(
			`Region "${region}" not found in "${relativePath}". ` +
				`Add "#region ${region}" and "#endregion" markers around the excerpt, ` +
				`or drop the region from src/examples.ts to show the whole file.`,
		);
	}
	const end = lines.findIndex((line, i) => i > start && /#endregion\b/.test(line));
	if (end === -1) {
		throw new Error(`Region "${region}" in "${relativePath}" has no matching #endregion.`);
	}

	const body = lines.slice(start + 1, end);
	const indent = Math.min(
		...body.filter((line) => line.trim()).map((line) => line.match(/^[\t ]*/)![0].length),
	);
	return `${body
		.map((line) => line.slice(indent))
		.join('\n')
		.replace(/\s+$/, '')}\n`;
}
