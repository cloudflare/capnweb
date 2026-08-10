import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import bundleSize from './generated/bundle-size.json' with { type: 'json' };

/**
 * Substitutes `%BUNDLE_SIZE%` in frontmatter.
 *
 * The remark plugin handles the token in page bodies, but frontmatter never reaches it: a content
 * collection parses and validates frontmatter before markdown is rendered, and Starlight reads the
 * page description and the landing page's hero tagline straight off the parsed entry. Doing it here
 * covers both, and anything else that grows a size claim later.
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

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: (context) => docsSchema()(context).transform(substituteTokens),
	}),
};
