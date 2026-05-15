#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WEB_DIR="$SCRIPT_DIR/web"
MODE="${1:-app}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/capnweb-worker-react-vite.XXXXXX")"
TMP_CONFIG="$TMP_DIR/vite.config.mjs"
TMP_WRANGLER_CONFIG="$TMP_DIR/wrangler.toml"
TYPECHECK=false
if [[ "$MODE" == "--typecheck" || "$MODE" == "typecheck" ]]; then
  TYPECHECK=true
elif [[ "$MODE" != "app" ]]; then
  echo "Usage: $0 [--typecheck]" >&2
  exit 1
fi
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
VITE_BASE="/examples/worker-react/web/"
VITE_PORT="${VITE_PORT:-$(node - <<'NODE'
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
  if (await isFree(5173)) {
    console.log(5173);
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

if [[ "$TYPECHECK" == "true" ]]; then
  cd "$REPO_ROOT"
  env NODE_OPTIONS= npm run build

  cd "$SCRIPT_DIR"
  echo "Debugging capnweb typecheck gen for examples/worker-react/src/worker.ts"
  if [[ "${TYPECHECK_DEBUG:-true}" == "false" || "${TYPECHECK_DEBUG:-true}" == "0" ]]; then
    env NODE_OPTIONS= node --enable-source-maps \
      "$REPO_ROOT/dist/cli.cjs" typecheck gen src/worker.ts --out .capnweb
  else
    echo "Typecheck generator is paused on start; attach the debugger, then continue."
    node --enable-source-maps --inspect-brk=0 \
      "$REPO_ROOT/dist/cli.cjs" typecheck gen src/worker.ts --out .capnweb
  fi
fi

VITE_PLUGIN_IMPORT=""
VITE_PLUGINS=""
WORKER_MAIN="$SCRIPT_DIR/src/worker.ts"
if [[ "$TYPECHECK" == "true" ]]; then
  VITE_PLUGIN_IMPORT="import capnweb from '$REPO_ROOT/dist/vite.js';"
  VITE_PLUGINS="plugins: [capnweb({ input: '$SCRIPT_DIR/src/worker.ts', outDir: '$SCRIPT_DIR/.capnweb' })],"
  WORKER_MAIN="$SCRIPT_DIR/.capnweb/worker.entry.ts"
fi

cat > "$TMP_CONFIG" <<EOF
import path from 'node:path';
$VITE_PLUGIN_IMPORT

export default {
  base: '$VITE_BASE',
  $VITE_PLUGINS
  resolve: {
    alias: [
      { find: 'capnweb/internal/typecheck', replacement: path.resolve('$REPO_ROOT/dist/index.js') },
      { find: 'capnweb', replacement: path.resolve('$REPO_ROOT/dist/index.js') },
    ],
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
    port: $VITE_PORT,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:$WORKER_PORT',
    },
  },
};
EOF

cat > "$TMP_WRANGLER_CONFIG" <<EOF
name = "capnweb-react-debug"
main = "$WORKER_MAIN"
compatibility_date = "2024-09-01"

[assets]
directory = "$SCRIPT_DIR/web/dist"

[vars]
DELAY_AUTH_MS = 80
DELAY_PROFILE_MS = 120
DELAY_NOTIFS_MS = 120
SIMULATED_RTT_MS = 120
SIMULATED_RTT_JITTER_MS = 40
EOF

cd "$REPO_ROOT"
if [[ "$TYPECHECK" == "false" ]]; then
  env NODE_OPTIONS= npm run build
fi

cd "$SCRIPT_DIR"
env NODE_OPTIONS= npx wrangler dev --config "$TMP_WRANGLER_CONFIG" --ip 127.0.0.1 --port "$WORKER_PORT" >/dev/null 2>&1 &
WRANGLER_PID=$!

cd "$WEB_DIR"
if [[ ! -d node_modules ]]; then
  env NODE_OPTIONS= npm install
fi
echo "Open this URL in VS Code Debug: Open Link:"
echo "http://127.0.0.1:$VITE_PORT$VITE_BASE"
env NODE_OPTIONS= npx vite --host 127.0.0.1 --port "$VITE_PORT" --strictPort --config "$TMP_CONFIG"
