/**
 * Replaces the `%BUNDLE_SIZE%` token with the measured size of the library.
 *
 * The number lives in exactly one place -- `src/generated/bundle-size.json`, written by
 * `scripts/measure-bundle.mjs` during prebuild -- so that a claim about the library's size cannot
 * go stale by being typed into prose. It is reached three different ways:
 *
 *   - this plugin, for prose in `.md` bodies, wired in as a Sätteri `mdastPlugins` entry
 *   - a `transform` on the content collection schema, for frontmatter
 *   - a plain `import` of the JSON, for `.mdx` pages, which can interpolate it directly
 *
 * Frontmatter never reaches the markdown pipeline: it is parsed and validated by Zod before the
 * body is compiled, and the layout reads the page description off the parsed entry. See
 * `src/content.config.ts`.
 *
 * This is a Sätteri plugin, not a remark one. Sätteri replaces unified's pipeline with a visitor
 * keyed by node type, where nodes are read-only and edits go through `context.setProperty`. The
 * shape is different but the work is the same, and it keeps the default processor -- swapping in
 * unified to run a remark plugin would give up Sätteri's performance for this one substitution.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TOKEN = /%BUNDLE_SIZE%/g;

/**
 * A factory rather than a plain definition, so the file is read once per compile. Prebuild writes
 * it, and a value captured when the Astro config was first evaluated would be stale for the rest of
 * the build.
 */
export function mdastBundleSize() {
	return () => {
		const { label } = require('../src/generated/bundle-size.json');

		/** Rewrites a node's `value` if it carries the token. */
		const substituteValue = (node, context) => {
			if (typeof node.value !== 'string' || !node.value.includes('%BUNDLE_SIZE%')) return;
			context.setProperty(node, 'value', node.value.replace(TOKEN, label));
		};

		// JSX attributes are deliberately not handled: Sätteri's op-stream cannot encode a
		// mutation of `attributes`, and an MDX page has a better option anyway -- import the JSON
		// and interpolate, as `index.mdx` does for the hero tagline and the download card.
		return {
			name: 'capnweb-bundle-size',
			text: substituteValue,
			inlineCode: substituteValue,
		};
	};
}
