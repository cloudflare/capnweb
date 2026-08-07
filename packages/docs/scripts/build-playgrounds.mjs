/**
 * Bundles each example in `src/examples.ts` into a self-contained page under
 * `public/playground/<slug>/`, which the playground pages load in an iframe.
 *
 * There is no server. The example's real Worker is bundled into the page next
 * to its real client, and a `fetch` shim routes the client's calls to the
 * Worker's `fetch` handler in-process. Everything above that -- the RPC
 * protocol, the batching, the request counting the demos report -- is the
 * genuine code path, so the demos stay honest while the whole site remains
 * static assets.
 *
 * Run by `predev` and `prebuild`, so it is never stale. Output is gitignored.
 */

import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const docsRoot = path.resolve(here, '..');
const repoRoot = path.resolve(docsRoot, '../..');

for (const sentinel of ['examples', 'dist/index.js', 'packages/capnweb-validate/dist/index.mjs']) {
	if (!existsSync(path.join(repoRoot, sentinel))) {
		throw new Error(
			`Expected ${sentinel} under ${repoRoot}. Run \`npm run build\` at the repo root first ` +
				`-- the playgrounds bundle the library's build output, not its source.`,
		);
	}
}

const fromRoot = (...parts) => path.join(repoRoot, ...parts);
const outRoot = path.join(docsRoot, 'public', 'playground');

/** The example's own build of the library, shared by its client and its Worker. */
const VENDOR = './vendor/capnweb.js';

/**
 * Strip comments from JSONC. Hand-rolled because the only alternative was
 * another dependency for one field; the string/escape tracking is the whole
 * reason this is not a regex.
 */
function parseJsonc(text, label) {
	let out = '';
	let inString = false;
	let inLine = false;
	let inBlock = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (inLine) {
			if (ch === '\n') { inLine = false; out += ch; }
			continue;
		}
		if (inBlock) {
			if (ch === '*' && next === '/') { inBlock = false; i++; }
			continue;
		}
		if (inString) {
			out += ch;
			if (ch === '\\') { out += next ?? ''; i++; }
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; out += ch; continue; }
		if (ch === '/' && next === '/') { inLine = true; i++; continue; }
		if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
		out += ch;
	}

	// Trailing commas are legal in JSONC and common in Wrangler configs.
	try {
		return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
	} catch (cause) {
		throw new Error(`Could not parse ${label} as JSONC: ${cause.message}`, { cause });
	}
}

/**
 * Resolve bare specifiers ourselves rather than leaning on the examples'
 * tsconfig `paths`, which point at `.d.ts` files that esbuild would try to
 * bundle. An `onResolve` hook also beats `paths`, so this stays predictable.
 */
function aliasPlugin(alias) {
	const entries = Object.entries({ capnweb: null, ...alias });
	const filter = new RegExp(`^(${entries.map(([k]) => k.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})$`);

	return {
		name: 'capnweb-playground-alias',
		setup(build) {
			build.onResolve({ filter }, (args) => {
				// One copy of the library per page, shared by client and Worker,
				// loaded as a sibling file rather than inlined into both bundles.
				if (args.path === 'capnweb') return { path: VENDOR, external: true };
				return { path: fromRoot(alias[args.path]) };
			});
		},
	};
}

/** The `capnweb-validate` codegen, which `@validateRpc()` needs to mean anything. */
async function validatePlugin(dir) {
	if (!dir) return [];
	const mod = await import(
		pathToFileURL(fromRoot('packages/capnweb-validate/dist/plugins/esbuild.mjs')).href
	);
	const factory = mod.default?.default ?? mod.default;
	return [factory({ cwd: fromRoot(dir), tsconfig: 'tsconfig.json' })];
}

async function bundle({ entry, outfile, alias, validate, extra = {} }) {
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: 'esm',
		target: 'es2022',
		platform: 'browser',
		minify: true,
		sourcemap: true,
		legalComments: 'none',
		jsx: 'automatic',
		define: { 'process.env.NODE_ENV': '"production"' },
		tsconfigRaw: {
			compilerOptions: {
				target: 'ES2022',
				useDefineForClassFields: false,
				experimentalDecorators: true,
			},
		},
		plugins: [...(await validatePlugin(validate)), aliasPlugin(alias ?? {})],
		...extra,
	});
}

/** The generated entry that stands in for the network. */
function shimSource({ server, rpcPath, env }) {
	return `
import worker from ${JSON.stringify(server)};

const RPC_PATH = ${JSON.stringify(rpcPath)};
const ENV = ${JSON.stringify(env)};

// Anything the Worker itself fetches still goes to the real network.
const upstream = globalThis.fetch.bind(globalThis);

const ctx = {
  waitUntil(promise) { Promise.resolve(promise).catch(() => {}); },
  passThroughOnException() {},
};

// Installed before the client module runs, so a client that wraps \`fetch\`
// itself -- as the React example does, to time its own requests -- layers on
// top of this and still measures the real call.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).pathname === RPC_PATH) {
    return await worker.fetch(request, ENV, ctx);
  }
  return upstream(input, init);
};
`;
}

function rewriteHtml(html, { clientScript, hasClient }) {
	let out = html;

	if (clientScript) {
		const tag = new RegExp(
			`<script[^>]*\\ssrc=["']${clientScript.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}["'][^>]*></script>`,
		);
		if (!tag.test(out)) {
			throw new Error(`No <script src="${clientScript}"> in the HTML shell to point at the bundled client.`);
		}
		out = out.replace(tag, '<script type="module" src="./client.js"></script>');
	}

	// The shim has to be evaluated before any client code, so it goes in front
	// of the first module script rather than at the end of <body>.
	const first = out.indexOf('<script type="module"');
	if (first === -1) throw new Error('No <script type="module"> in the HTML shell to anchor the runtime before.');

	const head = '<script type="module" src="./runtime.js"></script>\n\t\t';
	out = out.slice(0, first) + head + out.slice(first);

	if (hasClient) {
		out = out.replace('</head>', '\t<link rel="stylesheet" href="./client.css" />\n\t</head>');
	}
	return out;
}

async function buildExample(example) {
	const { slug, build: config } = example;
	const outDir = path.join(outRoot, slug);
	await mkdir(path.join(outDir, 'vendor'), { recursive: true });

	// One shared copy of the library, as a real file the page imports.
	await writeFile(path.join(outDir, 'vendor', 'capnweb.js'), await readFile(fromRoot('dist/index.js')));

	const wrangler = parseJsonc(await readFile(fromRoot(config.wrangler), 'utf8'), config.wrangler);
	const env = wrangler.vars ?? {};

	// The shim imports the Worker by absolute path, so it needs a stable dir to
	// be resolved from; the example's own directory keeps its relative imports
	// and its node_modules working.
	const shimPath = fromRoot(path.dirname(config.server), `.playground-entry-${slug}.mjs`);
	await writeFile(
		shimPath,
		shimSource({ server: './' + path.basename(config.server), rpcPath: config.rpcPath, env }),
	);

	try {
		await bundle({
			entry: shimPath,
			outfile: path.join(outDir, 'runtime.js'),
			alias: config.alias,
			validate: config.validate?.server,
		});
	} finally {
		await rm(shimPath, { force: true });
	}

	if (config.client) {
		await bundle({
			entry: fromRoot(config.client),
			outfile: path.join(outDir, 'client.js'),
			alias: config.alias,
			validate: config.validate?.client,
		});
	}

	const html = await readFile(fromRoot(config.html), 'utf8');
	await writeFile(
		path.join(outDir, 'index.html'),
		rewriteHtml(html, { clientScript: config.clientScript, hasClient: Boolean(config.client) }),
	);

	return `${slug} -> public/playground/${slug}/`;
}

const { examples } = await import(pathToFileURL(path.join(docsRoot, 'src', 'examples.ts')).href);

await rm(outRoot, { recursive: true, force: true });
for (const example of examples) {
	console.log('  playground:', await buildExample(example));
}
