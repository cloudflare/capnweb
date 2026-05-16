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

cd "$REPO_ROOT"
env NODE_OPTIONS= npm run build

# Runtime type validation toggles via the `capnweb-typecheck` placeholder
# package. `gen` overwrites it with real validators; `reset` puts the stub back
# so no validation runs. The worker entry never changes either way.
cd "$SCRIPT_DIR"
if [[ "$TYPECHECK" == "true" ]]; then
  echo "Generating RPC validators into capnweb-typecheck..."
  if [[ "${TYPECHECK_DEBUG:-false}" == "false" || "${TYPECHECK_DEBUG:-false}" == "0" ]]; then
    env NODE_OPTIONS= node --enable-source-maps \
      "$REPO_ROOT/dist/cli.cjs" typecheck gen src/worker.ts
  else
    echo "Typecheck generator is paused on start; attach the debugger, then continue."
    node --enable-source-maps --inspect-brk=0 \
      "$REPO_ROOT/dist/cli.cjs" typecheck gen src/worker.ts
  fi
else
  echo "Resetting capnweb-typecheck placeholder (validators disabled)..."
  env NODE_OPTIONS= node "$REPO_ROOT/dist/cli.cjs" typecheck reset
fi

cat > "$TMP_CONFIG" <<EOF
import path from 'node:path';

export default {
  base: '$VITE_BASE',
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
main = "$SCRIPT_DIR/src/worker.ts"
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

cd "$WEB_DIR"
if [[ ! -d node_modules ]]; then
  env NODE_OPTIONS= npm install
fi
if [[ ! -d dist ]]; then
  env NODE_OPTIONS= npx vite build --config "$TMP_CONFIG"
fi

cd "$SCRIPT_DIR"
env NODE_OPTIONS= npx wrangler dev --config "$TMP_WRANGLER_CONFIG" --ip 127.0.0.1 --port "$WORKER_PORT" >/dev/null 2>&1 &
WRANGLER_PID=$!

cd "$WEB_DIR"
echo "Open this URL in VS Code Debug: Open Link:"
echo "http://127.0.0.1:$VITE_PORT$VITE_BASE"
env NODE_OPTIONS= npx vite --host 127.0.0.1 --port "$VITE_PORT" --strictPort --config "$TMP_CONFIG"
