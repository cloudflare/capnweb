// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { sidebar } from './src/sidebar.mjs';
import { remarkBundleSize } from './scripts/remark-bundle-size.mjs';
import bundleSize from './src/generated/bundle-size.json' with { type: 'json' };

const REPO = 'https://github.com/cloudflare/capnweb';

export default defineConfig({
	// Set DOCS_SITE_URL once a canonical domain is chosen; it enables canonical
	// URLs, Open Graph URLs and sitemap generation.
	site: process.env.DOCS_SITE_URL,
	// Pull the next page into the HTTP cache while the pointer is resting on its
	// link, so that clicking it navigates from cache rather than from the network.
	//
	// This is what stops the one-frame flash of an empty page between navigations.
	// The stylesheet is hashed and immutable, so it is served from disk instantly,
	// while the HTML is fetched fresh every time; the browser therefore has enough
	// to paint a styled header before the body has finished arriving, and paints
	// it. The result is a frame of chrome over bare background -- which, in the
	// dark theme, reads as a flash to black. Locally the HTML arrives too fast for
	// the gap to open, which is why it only showed up once deployed.
	//
	// `hover` covers the pointer case that this affects. It deliberately stops
	// short of `viewport`, which would fetch every link in the sidebar on load,
	// and of `experimental.clientPrerender`, which runs the target page's scripts
	// -- and every page here starts a canvas animation.
	prefetch: {
		prefetchAll: true,
		defaultStrategy: 'hover',
	},
	// Substitutes %BUNDLE_SIZE% with the figure measured during prebuild. See
	// scripts/measure-bundle.mjs.
	markdown: {
		remarkPlugins: [remarkBundleSize],
	},
	integrations: [
		starlight({
			title: "Cap'n Web",
			description:
				`Cap'n Web is a JavaScript-native, object-capability RPC system with promise pipelining. No schemas, no boilerplate, ${bundleSize.label}.`,
			// Chrome keeps favicons in a store of its own, keyed by URL and not
			// touched by a hard reload, so a site that once served a different
			// icon keeps showing it for a long time. The version marker changes
			// the key. Bump it whenever favicon.svg changes.
			favicon: '/favicon.svg?v=2',
			customCss: ['./src/styles/theme.css'],
			components: {
				// Single-button light/dark toggle in place of the 3-option <select>.
				ThemeSelect: './src/components/ThemeToggle.astro',
				// Delegates to the stock hero; exists only to mount the WebGL field.
				Hero: './src/components/Hero.astro',
				// Delegates to the stock head; adds the generated social card.
				Head: './src/components/Head.astro',
				// Delegates to the stock frame; mounts the node field behind it.
				PageFrame: './src/components/PageFrame.astro',
			},
			social: [{ icon: 'github', label: 'GitHub', href: REPO }],
			editLink: {
				baseUrl: `${REPO}/edit/main/packages/docs/`,
			},
			lastUpdated: true,
			expressiveCode: {
				themes: ['github-dark-default', 'github-light'],
				styleOverrides: {
					borderRadius: '0.4rem',
					borderWidth: '1px',
					codeFontSize: '0.8125rem',
				},
			},
			head: [
				{
					tag: 'meta',
					attrs: { name: 'theme-color', content: '#05080f' },
				},
			],
			sidebar,
		}),
	],
});
