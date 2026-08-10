/**
 * Replaces the `%BUNDLE_SIZE%` token with the measured size of the library.
 *
 * The claim appears in ordinary prose, in two frontmatter strings (a page description and the
 * landing page's hero tagline) and in a JSX attribute on a card, so a plain text substitution is
 * not enough. All three are handled here, which keeps the number in exactly one place:
 * `src/generated/bundle-size.json`, written by `scripts/measure-bundle.mjs` during prebuild.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TOKEN = /%BUNDLE_SIZE%/g;

/** Replaces the token in every string reachable from `value`, in place where possible. */
function substitute(value, label) {
	if (typeof value === 'string') return value.replace(TOKEN, label);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) value[i] = substitute(value[i], label);
		return value;
	}
	if (value && typeof value === 'object') {
		for (const key of Object.keys(value)) value[key] = substitute(value[key], label);
		return value;
	}
	return value;
}

export function remarkBundleSize() {
	// Read lazily and fresh per build: prebuild writes the file, and a stale module-level import
	// would pin whatever was on disk when the config was first evaluated.
	const { label } = require('../src/generated/bundle-size.json');

	return (tree, file) => {
		// Frontmatter. Starlight nests the landing page's tagline under `hero`, so walk the whole
		// object rather than naming fields that will move.
		const frontmatter = file?.data?.astro?.frontmatter;
		if (frontmatter) substitute(frontmatter, label);

		const walk = (node) => {
			if (!node || typeof node !== 'object') return;

			if ((node.type === 'text' || node.type === 'inlineCode') && typeof node.value === 'string') {
				node.value = node.value.replace(TOKEN, label);
			}

			// MDX components: `<Card title="%BUNDLE_SIZE%">`. Expression attributes are left alone;
			// MDX can import the JSON directly if it needs the raw numbers.
			if (Array.isArray(node.attributes)) {
				for (const attr of node.attributes) {
					if (attr?.type === 'mdxJsxAttribute' && typeof attr.value === 'string') {
						attr.value = attr.value.replace(TOKEN, label);
					}
				}
			}

			if (Array.isArray(node.children)) for (const child of node.children) walk(child);
		};

		walk(tree);
	};
}
