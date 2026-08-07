// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

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
			logo: {
				src: './src/assets/captain-web.jpg',
				alt: "Cap'n Web -- Protect & Connect",
			},
			favicon: '/favicon.svg',
			customCss: ['./src/styles/theme.css'],
			components: {
				// Single-button light/dark toggle in place of the 3-option <select>.
				ThemeSelect: './src/components/ThemeToggle.astro',
			},
			social: [{ icon: 'github', label: 'GitHub', href: REPO }],
			editLink: {
				baseUrl: `${REPO}/edit/main/packages/docs/`,
			},
			lastUpdated: true,
			expressiveCode: {
				themes: ['github-dark-default', 'github-light'],
				styleOverrides: {
					borderRadius: '0.5rem',
					borderWidth: '1px',
					codeFontSize: '0.8125rem',
				},
			},
			head: [
				{
					tag: 'meta',
					attrs: { name: 'theme-color', content: '#1a2f3b' },
				},
			],
			sidebar: [
				{
					label: 'Start Here',
					items: [
						{ label: 'Introduction', slug: 'start/introduction' },
						{ label: 'Installation', slug: 'start/installation' },
						{ label: 'Quickstart', slug: 'start/quickstart' },
						{ label: 'Pipelining Tour', slug: 'start/pipelining-tour' },
					],
				},
				{
					label: 'Core Concepts',
					items: [
						{ label: 'What Can Be Passed', slug: 'concepts/values' },
						{ label: 'RpcTarget & Functions', slug: 'concepts/rpc-target' },
						{ label: 'RpcStub', slug: 'concepts/stubs' },
						{ label: 'RpcPromise & Pipelining', slug: 'concepts/promises' },
						{ label: 'The magic map()', slug: 'concepts/map' },
						{ label: 'Streaming', slug: 'concepts/streaming' },
						{ label: 'Disposal', slug: 'concepts/disposal' },
					],
				},
				{
					label: 'Transports',
					items: [
						{ label: 'Overview', slug: 'transports' },
						{ label: 'HTTP Batch', slug: 'transports/http-batch' },
						{ label: 'WebSocket', slug: 'transports/websocket' },
						{ label: 'MessagePort', slug: 'transports/message-port' },
						{ label: 'Custom Transports', slug: 'transports/custom' },
					],
				},
				{
					label: 'Server Runtimes',
					items: [
						{ label: 'Cloudflare Workers', slug: 'servers/workers' },
						{ label: 'Node.js', slug: 'servers/node' },
						{ label: 'Deno', slug: 'servers/deno' },
						{ label: 'Bun', slug: 'servers/bun' },
						{ label: 'Hono', slug: 'servers/hono' },
						{ label: 'Other Runtimes', slug: 'servers/other' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Security Considerations', slug: 'guides/security' },
						{ label: 'Workers RPC Interop', slug: 'guides/workers-rpc' },
						{ label: 'Runtime Validation', slug: 'guides/validation' },
					],
				},
				{
					label: 'Examples',
					items: [
						{ label: 'Batch + Pipelining', slug: 'examples/batch-pipelining' },
						{ label: 'Workers + React', slug: 'examples/worker-react' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Wire Protocol', slug: 'reference/protocol' },
						{ label: 'API Cheat Sheet', slug: 'reference/api' },
					],
				},
			],
		}),
	],
});
