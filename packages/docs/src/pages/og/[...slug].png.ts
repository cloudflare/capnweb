/**
 * One social card per documentation page, rasterized at build time.
 *
 * `/og/guides/sessions.png` for `/guides/sessions/`, and `/og/index.png` for
 * the landing page. `src/components/Head.astro` points each page at its own.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { renderCard } from '../../lib/og-card.js';
import { sectionForSlug } from '../../sidebar.mjs';

/** The landing page has no slug of its own; give its card a stable name. */
const INDEX = 'index';

export const getStaticPaths: GetStaticPaths = async () => {
	const pages = await getCollection('docs');

	return pages.map((page) => {
		const slug = page.id === '' ? INDEX : page.id;

		// Splash pages carry their headline in `hero`, not `title` -- the
		// frontmatter title is the browser tab, which is not what belongs on a card.
		const hero = page.data.hero;

		return {
			params: { slug },
			props: {
				title: hero?.title ?? page.data.title,
				description: hero?.tagline ?? page.data.description,
				section: sectionForSlug(page.id),
				seed: slug,
			},
		};
	});
};

export const GET: APIRoute = async ({ props }) => {
	const png = await renderCard(props as Parameters<typeof renderCard>[0]);

	return new Response(new Uint8Array(png), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=31536000, immutable',
		},
	});
};
