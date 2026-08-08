// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { sidebar } from './src/sidebar.mjs';

const REPO = 'https://github.com/cloudflare/capnweb';

export default defineConfig({
	// Set DOCS_SITE_URL once a canonical domain is chosen; it enables canonical
	// URLs, Open Graph URLs and sitemap generation.
	site: process.env.DOCS_SITE_URL,
	integrations: [
		starlight({
			title: "Cap'n Web",
			description:
				"Cap'n Web is a JavaScript-native, object-capability RPC system with promise pipelining. No schemas, no boilerplate, under 10kB.",
			favicon: '/favicon.svg',
			customCss: ['./src/styles/theme.css'],
			components: {
				// Single-button light/dark toggle in place of the 3-option <select>.
				ThemeSelect: './src/components/ThemeToggle.astro',
				// Delegates to the stock hero; exists only to mount the WebGL field.
				Hero: './src/components/Hero.astro',
				// Delegates to the stock head; adds the generated social card.
				Head: './src/components/Head.astro',
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
