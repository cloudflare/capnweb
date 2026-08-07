/**
 * The live examples, each deployed to its own subdomain of capnweb.com.
 *
 * The URLs are overridable so that `npm run dev` at the repo root can point
 * them at the local Wrangler servers instead. Those overrides live in
 * `.env.development`, which Vite loads only in dev mode -- a production build
 * always falls back to the deployed subdomains below.
 */

export interface Example {
	/** Directory under `examples/` in the repo. */
	slug: string;
	title: string;
	description: string;
	/** Where the running demo lives. */
	href: string;
	/** Source on GitHub. */
	source: string;
}

const REPO = 'https://github.com/cloudflare/capnweb/tree/main/examples';

export const examples: Example[] = [
	{
		slug: 'batch-pipelining',
		title: 'Batch + pipelining',
		description:
			'Three dependent calls in a single HTTP round trip, measured against the same calls made sequentially. Drag the latency slider to see the gap widen.',
		href:
			import.meta.env.PUBLIC_EXAMPLE_BATCH_PIPELINING_URL ??
			'https://batch-pipelining.capnweb.com',
		source: `${REPO}/batch-pipelining`,
	},
	{
		slug: 'worker-react',
		title: 'Workers + React',
		description:
			'The same comparison from a React app served by a Worker, with a request timeline and runtime validation at the RPC boundary.',
		href: import.meta.env.PUBLIC_EXAMPLE_WORKER_REACT_URL ?? 'https://worker-react.capnweb.com',
		source: `${REPO}/worker-react`,
	},
];
