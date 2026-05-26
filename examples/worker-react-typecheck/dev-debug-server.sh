#!/usr/bin/env bash
# Build the typechecked debug copy of the Worker and run wrangler dev
# with the inspector exposed on $INSPECTOR_PORT for VS Code debugging.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKER_PORT="${WORKER_PORT:-8787}"
INSPECTOR_PORT="${INSPECTOR_PORT:-9229}"
OUT_DIR="${OUT_DIR:-.wrangler/typecheck}"
DEBUG_CONFIG="$SCRIPT_DIR/.wrangler/typecheck-wrangler.toml"
case "$OUT_DIR" in
  /*) OUT_PATH="$OUT_DIR" ;;
  *) OUT_PATH="$SCRIPT_DIR/$OUT_DIR" ;;
esac

cd "$REPO_ROOT"
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  env NODE_OPTIONS= npm run build
fi

rm -rf "$OUT_PATH"

env NODE_OPTIONS= node \
  "$REPO_ROOT/packages/capnweb-typecheck/dist/cli.cjs" build \
  --cwd "$SCRIPT_DIR" \
  --out "$OUT_DIR"

mkdir -p "$SCRIPT_DIR/.wrangler"
cat > "$DEBUG_CONFIG" <<EOF2
name = "capnweb-react-typecheck-example"
main = "$OUT_PATH/src/worker.ts"
compatibility_date = "2024-09-01"

[alias]
"capnweb" = "$REPO_ROOT/dist/index-workers.js"
"capnweb-typecheck" = "$REPO_ROOT/packages/capnweb-typecheck/dist/index.mjs"
"capnweb-typecheck/internal" = "$REPO_ROOT/packages/capnweb-typecheck/dist/internal/runtime.mjs"

[vars]
DELAY_AUTH_MS = 80
DELAY_PROFILE_MS = 120
DELAY_NOTIFS_MS = 120
SIMULATED_RTT_MS = 120
SIMULATED_RTT_JITTER_MS = 40
EOF2

cat > "$OUT_PATH/tsconfig.json" <<EOF2
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "capnweb": ["$REPO_ROOT/dist/index-workers.d.ts"],
      "capnweb-typecheck": ["$REPO_ROOT/packages/capnweb-typecheck/dist/index.d.mts"],
      "capnweb-typecheck/internal": ["$REPO_ROOT/packages/capnweb-typecheck/dist/internal/runtime.d.mts"]
    }
  },
  "include": ["src/**/*"]
}
EOF2

echo
echo "Worker source for breakpoints: $OUT_PATH/src/worker.ts"
echo "VS Code attach: 127.0.0.1:$INSPECTOR_PORT"
echo "API: http://127.0.0.1:$WORKER_PORT/api"
echo

cd "$SCRIPT_DIR"
exec env NODE_OPTIONS= npx wrangler dev \
  --config "$DEBUG_CONFIG" \
  --ip 127.0.0.1 \
  --port "$WORKER_PORT" \
  --inspector-port "$INSPECTOR_PORT"
