#!/usr/bin/env bash
# Build the typechecked debug copy of the React client and start Vite,
# waiting for the Worker backend at $WORKER_PORT/api before serving.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WEB_DIR="$REPO_ROOT/examples/worker-react/web"
CLIENT_DIR="$SCRIPT_DIR/.wrangler/typecheck-web"
VITE_PORT="${VITE_PORT:-5173}"
WORKER_PORT="${WORKER_PORT:-8787}"
BACKEND_WAIT_MS="${BACKEND_WAIT_MS:-30000}"

if [[ "${SKIP_BACKEND_WAIT:-0}" != "1" ]]; then
  echo "Waiting for Worker: http://127.0.0.1:$WORKER_PORT/api"
  env NODE_OPTIONS= node - "$WORKER_PORT" "$BACKEND_WAIT_MS" <<'NODE'
const [port, timeoutMs] = process.argv.slice(2).map(Number);
const url = `http://127.0.0.1:${port}/api`;
const deadline = Date.now() + timeoutMs;
let lastError = "not ready";

async function probe() {
  let controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), 500);
  try {
    let response = await fetch(url, { method: "OPTIONS", signal: controller.signal });
    if (response.status === 204) return true;
    lastError = `HTTP ${response.status}`;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeout);
  }
  return false;
}

while (Date.now() < deadline) {
  if (await probe()) process.exit(0);
  await new Promise(resolve => setTimeout(resolve, 250));
}

console.error(`Worker not ready at ${url} after ${timeoutMs}ms (${lastError}).`);
console.error("Start dev-debug-server.sh first, or set SKIP_BACKEND_WAIT=1.");
process.exit(1);
NODE
fi

cd "$REPO_ROOT"
if [[ "${FORCE_BUILD:-0}" == "1" || ! -f dist/index.js || ! -f packages/capnweb-typecheck/dist/plugins/vite.mjs ]]; then
  env NODE_OPTIONS= npm run build
fi

cd "$WEB_DIR"
if [[ ! -d node_modules ]]; then
  env NODE_OPTIONS= npm install
fi

rm -rf "$CLIENT_DIR"
mkdir -p "$CLIENT_DIR"
cp "$WEB_DIR/index.html" "$CLIENT_DIR/index.html"
cp "$WEB_DIR/tsconfig.json" "$CLIENT_DIR/tsconfig.json"
cp -R "$WEB_DIR/src" "$CLIENT_DIR/src"
ln -s "$WEB_DIR/node_modules" "$CLIENT_DIR/node_modules"

env NODE_OPTIONS= node - "$CLIENT_DIR" "$REPO_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [clientDir, repoRoot] = process.argv.slice(2);

function replaceOnce(source, from, to) {
  if (!source.includes(from)) {
    throw new Error(`Expected client source to contain: ${from}`);
  }
  return source.replace(from, to);
}

const app = path.join(clientDir, "src/main/App.tsx");
let source = fs.readFileSync(app, "utf8");
source = replaceOnce(
  source,
  "import { newHttpBatchRpcSession } from 'capnweb'",
  "import { newHttpBatchRpcSession } from 'capnweb-typecheck'",
);
source = replaceOnce(
  source,
  "import type { Api } from '../../../src/worker'",
  "import type { Api } from '../../../../src/worker'",
);
fs.writeFileSync(app, source);

const tsconfig = path.join(clientDir, "tsconfig.json");
const config = JSON.parse(fs.readFileSync(tsconfig, "utf8"));
const compiler = config.compilerOptions ??= {};
compiler.baseUrl = ".";
compiler.types = ["@cloudflare/workers-types"];
compiler.paths = {
  capnweb: [path.join(repoRoot, "dist/index.d.ts")],
  "capnweb-typecheck": [path.join(repoRoot, "packages/capnweb-typecheck/dist/index.d.mts")],
  "capnweb-typecheck/internal": [path.join(repoRoot, "packages/capnweb-typecheck/dist/internal/runtime.d.mts")],
};
fs.writeFileSync(tsconfig, JSON.stringify(config, null, 2) + "\n");
NODE

cat > "$CLIENT_DIR/vite.debug.mjs" <<EOF2
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const capnwebTypecheck = (await import(
  pathToFileURL(path.resolve('$REPO_ROOT/packages/capnweb-typecheck/dist/plugins/vite.mjs')).href
)).default;

const debugAliases = {
  'capnweb-typecheck/internal': path.resolve('$REPO_ROOT/packages/capnweb-typecheck/dist/internal/runtime.mjs'),
  'capnweb-typecheck': path.resolve('$REPO_ROOT/packages/capnweb-typecheck/dist/index.mjs'),
  'capnweb': path.resolve('$REPO_ROOT/dist/index.js'),
};

export default {
  root: '$CLIENT_DIR',
  plugins: [
    {
      name: 'capnweb-typecheck-debug-alias',
      enforce: 'pre',
      resolveId(id) {
        return debugAliases[id] ?? null;
      },
    },
    capnwebTypecheck({
      cwd: '$CLIENT_DIR',
      tsconfig: 'tsconfig.json',
    }),
    {
      name: 'capnweb-typecheck-debug-runtime-imports',
      enforce: 'post',
      transform(code, id) {
        if (!id.startsWith('$CLIENT_DIR/') || !code.includes('capnweb')) return null;
        let next = code
          .replaceAll('"capnweb-typecheck/internal"', JSON.stringify('/@fs/' + debugAliases['capnweb-typecheck/internal']))
          .replaceAll("'capnweb-typecheck/internal'", JSON.stringify('/@fs/' + debugAliases['capnweb-typecheck/internal']))
          .replaceAll('"capnweb-typecheck"', JSON.stringify('/@fs/' + debugAliases['capnweb-typecheck']))
          .replaceAll("'capnweb-typecheck'", JSON.stringify('/@fs/' + debugAliases['capnweb-typecheck']))
          .replaceAll('"capnweb"', JSON.stringify('/@fs/' + debugAliases['capnweb']))
          .replaceAll("'capnweb'", JSON.stringify('/@fs/' + debugAliases['capnweb']));
        return next === code ? null : { code: next, map: null };
      },
    },
  ],
  resolve: {
    alias: Object.entries(debugAliases).map(([find, replacement]) => ({ find, replacement })),
  },
  build: { target: 'esnext' },
  esbuild: {
    target: 'esnext',
    supported: { 'top-level-await': true },
  },
  server: {
    host: '127.0.0.1',
    port: $VITE_PORT,
    strictPort: true,
    fs: { allow: ['$REPO_ROOT'] },
    proxy: { '/api': 'http://127.0.0.1:$WORKER_PORT' },
  },
};
EOF2

echo
echo "Client source for breakpoints: $CLIENT_DIR/src/main/App.tsx"
echo "Open: http://127.0.0.1:$VITE_PORT"
echo "Proxy /api -> http://127.0.0.1:$WORKER_PORT"
echo

cd "$CLIENT_DIR"
exec env NODE_OPTIONS= npx vite \
  --host 127.0.0.1 \
  --port "$VITE_PORT" \
  --strictPort \
  --config "$CLIENT_DIR/vite.debug.mjs"
