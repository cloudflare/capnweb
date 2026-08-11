import { defineCollection } from 'astro:content';
import { docsCollection, partialsCollection } from '@cloudflare/nimbus-docs/content';
import bundleSize from './generated/bundle-size.json' with { type: 'json' };

/**
 * Substitutes `%BUNDLE_SIZE%` in frontmatter.
 *
 * The markdown plugin handles the token in page bodies, but frontmatter never reaches it: the
 * collection parses and validates frontmatter with Zod before the body is compiled, and the layout
 * reads the page description off the parsed entry. Doing it here covers that, and anything else
 * that grows a size claim later.
 *
 * See `scripts/mdast-bundle-size.mjs` for the body half and `scripts/measure-bundle.mjs` for where
 * the number comes from.
 */
function substituteTokens<T>(value: T): T {
	if (typeof value === 'string') {
		return value.replaceAll('%BUNDLE_SIZE%', bundleSize.label) as T;
	}
	if (Array.isArray(value)) {
		return value.map(substituteTokens) as T;
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [key, substituteTokens(inner)])
		) as T;
	}
	return value;
}

const docs = docsCollection();

export const collections = {
	docs: defineCollection({
		loader: docs.loader,
		// `substituteTokens` is identity-typed (`<T>(value: T) => T`), so the
		// transform keeps Nimbus's inferred frontmatter type intact and
		// `entry.data` stays fully typed at every call site.
		schema: docs.schema.transform(substituteTokens),
	}),
	partials: defineCollection(partialsCollection()),
};
