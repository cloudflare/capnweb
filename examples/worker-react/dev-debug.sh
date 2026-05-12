#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WEB_DIR="$SCRIPT_DIR/web"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/capnweb-worker-react-vite.XXXXXX")"
TMP_CONFIG="$TMP_DIR/vite.config.mjs"
WORKER_PORT="${WORKER_PORT:-$(node - <<'NODE'
const net = require('node:net');

function isFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

(async () => {
  if (await isFree(8787)) {
    console.log(8787);
    return;
  }
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => console.log(address.port));
  });
})();
NODE
)}"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "${WRANGLER_PID:-}" ]]; then
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
  exit "$status"
}

trap cleanup EXIT INT TERM

cat > "$TMP_CONFIG" <<EOF
import path from 'node:path';

export default {
  resolve: {
    alias: {
      capnweb: path.resolve('$REPO_ROOT/dist/index.js'),
    },
  },
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
    supported: {
      'top-level-await': true,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:$WORKER_PORT',
    },
  },
};
EOF

cd "$REPO_ROOT"
env NODE_OPTIONS= npm run build

cd "$SCRIPT_DIR"
env NODE_OPTIONS= npx wrangler dev --ip 127.0.0.1 --port "$WORKER_PORT" >/dev/null 2>&1 &
WRANGLER_PID=$!

cd "$WEB_DIR"
if [[ ! -d node_modules ]]; then
  env NODE_OPTIONS= npm install
fi
echo "Open this URL in VS Code Debug: Open Link:"
echo "http://127.0.0.1:5173"
env NODE_OPTIONS= npx vite --host 127.0.0.1 --port 5173 --config "$TMP_CONFIG"
