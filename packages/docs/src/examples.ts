/**
 * The live examples: the ones in `examples/`, rendered as playground pages here.
 *
 * This file is the single source of truth for two consumers:
 *
 *   - the playground pages, which read `files` to show the source, and
 *   - `scripts/build-playgrounds.mjs`, which reads `build` to bundle each
 *     example into a self-contained page that runs in an iframe.
 *
 * There is no server behind the playgrounds. Each one bundles the example's
 * real Worker into the page alongside its real client, and routes the client's
 * `fetch` of `rpcPath` straight into that Worker's `fetch` handler. The wire
 * format is the genuine HTTP batch protocol, so the request counts the demos
 * report are real -- there is simply no network under them. That is what lets
 * the whole site deploy as static assets.
 */

export interface PlaygroundFile {
	/** Path from the repo root. Read at build time; a bad path fails the build. */
	path: string;
	/**
	 * Show only the named `#region` of the file rather than the whole thing.
	 * Used where a file is mostly boilerplate; the markers live in the source.
	 */
	region?: string;
	/** Tab label. */
	label: string;
	/** Language for syntax highlighting. */
	lang: string;
	/** One line on what this file is for, shown above the code. */
	note: string;
}

export interface PlaygroundBuild {
	/** HTML shell, copied from the example and rewritten. Repo-relative. */
	html: string;
	/** Worker module whose default export has the `fetch` handler. */
	server: string;
	/** Requests to this path are served by `server`, in-page. Omit for `wsPath`. */
	rpcPath?: string;
	/**
	 * For WebSocket examples: `new WebSocket()` on this path is answered by an
	 * in-page pair rather than a real socket, with `mainExport` on the other
	 * end. Mutually exclusive with `rpcPath`.
	 */
	wsPath?: string;
	/** Named export of `server` returning the session's main interface. */
	mainExport?: string;
	/**
	 * The example's Wrangler config. Its `vars` become the Worker's `env`, so
	 * the playground runs with the same delays as a real deployment instead of
	 * a second copy of those numbers drifting out of sync over here.
	 */
	wrangler: string;
	/**
	 * Client entry to bundle. Omit when the client is inline in `html`, as it
	 * is for the batch example.
	 */
	client?: string;
	/** `src` of the script tag in `html` to point at the bundled client. */
	clientScript?: string;
	/** Bare specifier -> repo-relative file, for esbuild. */
	alias?: Record<string, string>;
	/**
	 * Static files the page references by name, copied next to it. Needed for a
	 * zero-build example, whose stylesheet is a plain `<link>` rather than
	 * something imported from JavaScript for a bundler to find.
	 */
	assets?: string[];
	/**
	 * Directories to run the `capnweb-validate` codegen plugin in. Its
	 * `@validateRpc()` decorator is a build-time transform, so a bundle built
	 * without this silently loses the validation the example is demonstrating.
	 */
	validate?: { server?: string; client?: string };
}

export interface Example {
	/** Directory under `examples/`, and the page slug under `/examples/`. */
	slug: string;
	title: string;
	/** Short form, for cards and the sidebar. */
	tagline: string;
	description: string;
	/** Source on GitHub. */
	source: string;
	/** The playground page on this site. */
	docsPath: string;
	/** The generated, self-contained demo. Loaded into the playground iframe. */
	demoPath: string;
	files: PlaygroundFile[];
	build: PlaygroundBuild;
}

const REPO = 'https://github.com/cloudflare/capnweb/tree/main/examples';

/**
 * Where `scripts/build-playgrounds.mjs` writes each demo. Derived from the slug
 * so the config and the bundler cannot disagree about the path.
 *
 * `index.html` is spelled out on purpose. Astro's dev server does not resolve a
 * directory request under `public/` to its index, so `/playground/<slug>/` is a
 * 404 in dev even though most static hosts would serve it.
 */
const demoPathFor = (slug: string) => `/playground/${slug}/index.html`;

/** Shared by both examples: the monorepo's own builds, not published copies. */
const VALIDATE_ALIAS = {
	'capnweb-validate/internal/core': 'packages/capnweb-validate/dist/internal/core.mjs',
	'capnweb-validate/internal/capnweb': 'packages/capnweb-validate/dist/internal/capnweb.mjs',
	'capnweb-validate/internal': 'packages/capnweb-validate/dist/internal/runtime.mjs',
	'capnweb-validate/capnweb': 'packages/capnweb-validate/dist/capnweb.mjs',
	'capnweb-validate': 'packages/capnweb-validate/dist/index.mjs',
};

const entries: Omit<Example, 'demoPath'>[] = [
	{
		slug: 'batch-pipelining',
		title: 'Batch + pipelining',
		tagline: 'One round trip, three dependent calls',
		description:
			'Three dependent calls in a single HTTP round trip, measured against the same calls made sequentially. Drag the latency slider to see the gap widen.',
		source: `${REPO}/batch-pipelining`,
		docsPath: '/examples/batch-pipelining/',
		build: {
			html: 'examples/batch-pipelining/public/index.html',
			server: 'examples/batch-pipelining/worker.js',
			rpcPath: '/rpc',
			wrangler: 'examples/batch-pipelining/wrangler.jsonc',
		},
		files: [
			{
				path: 'examples/batch-pipelining/public/index.html',
				region: 'demo',
				label: 'index.html',
				lang: 'js',
				note: 'The two strategies, exactly as the running demo does them. Everything else in the file is markup and styling.',
			},
			{
				path: 'examples/batch-pipelining/api.mjs',
				label: 'api.mjs',
				lang: 'js',
				note: 'The RPC API. Shared by the Worker and the Node server so the two cannot drift.',
			},
			{
				path: 'examples/batch-pipelining/worker.js',
				label: 'worker.js',
				lang: 'js',
				note: 'The Cloudflare Worker serving /rpc. This is the code answering the calls in the demo.',
			},
			{
				path: 'examples/batch-pipelining/server-node.mjs',
				label: 'server-node.mjs',
				lang: 'js',
				note: 'The same API on a plain Node HTTP server, for running it outside Workers.',
			},
			{
				path: 'examples/batch-pipelining/client.mjs',
				label: 'client.mjs',
				lang: 'js',
				note: 'The same comparison from a terminal. Point it at any of the servers with RPC_URL.',
			},
		],
	},
	{
		slug: 'worker-react',
		title: 'Workers + React',
		tagline: 'The same trick from a React app',
		description:
			'The same comparison from a React app served by a Worker, with a request timeline and runtime validation at the RPC boundary.',
		source: `${REPO}/worker-react`,
		docsPath: '/examples/worker-react/',
		build: {
			html: 'examples/worker-react/client/index.html',
			server: 'examples/worker-react/server/worker.ts',
			client: 'examples/worker-react/client/src/main.tsx',
			clientScript: '/src/main.tsx',
			rpcPath: '/api',
			wrangler: 'examples/worker-react/wrangler.jsonc',
			alias: VALIDATE_ALIAS,
			validate: {
				server: 'examples/worker-react/server',
				client: 'examples/worker-react/client',
			},
		},
		files: [
			{
				path: 'examples/worker-react/server/worker.ts',
				label: 'worker.ts',
				lang: 'ts',
				note: 'The Worker. @validateRpc() adds runtime type checks at the RPC boundary.',
			},
			{
				path: 'examples/worker-react/client/src/main/App.tsx',
				region: 'runs',
				label: 'App.tsx',
				lang: 'tsx',
				note: 'The two strategies, as React callbacks. The rest of the file is the timeline chart and layout.',
			},
			{
				path: 'examples/worker-react/client/vite.config.ts',
				label: 'vite.config.ts',
				lang: 'ts',
				note: 'Vite config, including the validation plugin and the /api dev proxy.',
			},
		],
	},
	{
		slug: 'session-recovery',
		title: 'Session recovery',
		tagline: 'What a disconnect destroys',
		description:
			'A WebSocket session with a button that kills it. Watch every stub break, then watch the event stream resume without a gap because the client kept a cursor of its own.',
		source: `${REPO}/session-recovery`,
		docsPath: '/examples/session-recovery/',
		build: {
			html: 'examples/session-recovery/public/index.html',
			server: 'examples/session-recovery/worker.js',
			client: 'examples/session-recovery/public/main.js',
			clientScript: './main.js',
			wsPath: '/ws',
			mainExport: 'createMain',
			assets: ['examples/session-recovery/public/style.css'],
			wrangler: 'examples/session-recovery/wrangler.jsonc',
		},
		files: [
			{
				path: 'examples/session-recovery/public/session.js',
				label: 'session.js',
				lang: 'js',
				note: 'The client. Connecting, authenticating, subscribing, and recovering from a drop -- with no DOM in it.',
			},
			{
				path: 'examples/session-recovery/api.mjs',
				label: 'api.mjs',
				lang: 'js',
				note: 'The RPC API. The event log is created outside the session on purpose: that is what lets a resume work.',
			},
			{
				path: 'examples/session-recovery/worker.js',
				label: 'worker.js',
				lang: 'js',
				note: 'The Worker. One endpoint, upgrading to a WebSocket and handing over a fresh main interface.',
			},
			{
				path: 'examples/session-recovery/public/main.js',
				label: 'main.js',
				lang: 'js',
				note: 'DOM wiring. Kept separate so the file above stays about RPC.',
			},
		],
	},
];

export const examples: Example[] = entries.map((entry) => ({
	...entry,
	demoPath: demoPathFor(entry.slug),
}));

export function exampleBySlug(slug: string): Example {
	const found = examples.find((example) => example.slug === slug);
	if (!found) {
		throw new Error(`Unknown example "${slug}". Known: ${examples.map((e) => e.slug).join(', ')}`);
	}
	return found;
}
