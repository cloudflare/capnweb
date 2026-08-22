import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import nimbus, { defineConfig as defineNimbusConfig } from '@cloudflare/nimbus-docs';
import { tableScroll } from '@cloudflare/nimbus-docs/markdown';
import { mdastBundleSize } from './scripts/mdast-bundle-size.mjs';
import bundleSize from './src/generated/bundle-size.json' with { type: 'json' };

const REPO = 'https://github.com/cloudflare/capnweb';

const nimbusConfig = defineNimbusConfig({
	// Nimbus requires a canonical origin: it drives canonical URLs, the absolute OG image URLs,
	// robots.txt, the sitemap and the links inside /llms.txt. `DOCS_SITE_URL` overrides it, which
	// is what preview deployments want -- otherwise a preview publishes a sitemap and a set of
	// canonicals all claiming to be production.
	site: process.env.DOCS_SITE_URL ?? 'https://capnweb.com',
	title: "Cap'n Web",
	description: `A JavaScript-native, object-capability RPC system with promise pipelining. No schemas, no boilerplate, ${bundleSize.label}.`,
	locale: 'en',
	github: REPO,
	editPattern: `${REPO}/edit/main/packages/docs/{path}`,
	socialImageAlt: "Cap'n Web documentation",
	// Browser chrome follows the scheme. The media queries are asked the same way
	// round as the bootstrap in BaseLayout: light only when the OS asks for it,
	// dark otherwise, because dark is this site's answer to "no preference". A
	// stored choice that disagrees with the OS is reconciled by that same script,
	// which rewrites these once it has resolved the mode.
	head: [
		{
			tag: 'meta',
			attrs: { name: 'theme-color', content: '#eef1f4', media: '(prefers-color-scheme: light)' },
		},
		{
			tag: 'meta',
			attrs: { name: 'theme-color', content: '#070a11', media: '(prefers-color-scheme: dark)' },
		},
	],
	// Ordering is explicit rather than left to the filesystem. The groups are the shape of the
	// library, not the shape of the directory tree, and the order inside each one is a reading
	// order: it goes from the thing you need first to the thing you need last. `sidebar.order` in
	// each page's frontmatter decides its position within its group.
	sidebar: {
		items: [
			{ label: 'Start Here', autogenerate: { directory: 'start' } },
			{ label: 'Core Concepts', autogenerate: { directory: 'concepts' } },
			{ label: 'Transports', autogenerate: { directory: 'transports' } },
			{ label: 'Server Runtimes', autogenerate: { directory: 'servers' } },
			{ label: 'Guides', autogenerate: { directory: 'guides' } },
			{ label: 'Examples', autogenerate: { directory: 'examples' } },
			{
				label: 'Reference',
				items: [
					{ autogenerate: { directory: 'reference' } },
					// Off-site on purpose. Release notes are generated from changesets on every
					// publish, so a page here would be a copy that goes stale the next time
					// anyone ships.
					{ label: 'Changelog', link: 'https://github.com/cloudflare/capnweb/releases' },
				],
			},
		],
	},
});

export default defineConfig({
	output: 'static',
	// Tailwind v4 through its Vite plugin, which is what Astro 7 wants: the PostCSS plugin does not
	// build under Vite 8.
	vite: {
		plugins: [tailwindcss()],
	},
	// Pull the next page into the HTTP cache while the pointer is resting on its link, so that
	// clicking it navigates from cache rather than from the network. Paired with the cache policy in
	// `public/_headers`, without which a prefetched page cannot be reused: Workers' default for
	// static assets is `must-revalidate`, and a response that must be revalidated is refetched on
	// the click. That refetch is what put a frame of unstyled page between navigations.
	//
	// `hover` deliberately stops short of `viewport`, which would fetch every link in the sidebar on
	// load.
	prefetch: {
		prefetchAll: true,
		defaultStrategy: 'hover',
	},
	integrations: [
		nimbus(nimbusConfig, {
			// Frontmatter has to validate for a page to render, and a broken internal link is a 404
			// for a reader; both are build failures rather than warnings. The rest of the authoring
			// rules stay off -- this repo already lints markdown with markdownlint at the root.
			rules: {
				'nimbus/frontmatter-shape': 'error',
				'nimbus/internal-link': 'error',
			},
			markdown: {
				// Wide tables scroll instead of overflowing the measure.
				hastPlugins: [tableScroll()],
				// Substitutes %BUNDLE_SIZE% in the body. See scripts/mdast-bundle-size.mjs.
				mdastPlugins: [mdastBundleSize()],
			},
		}),
	],
});
