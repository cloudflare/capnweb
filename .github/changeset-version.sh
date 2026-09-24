#! /bin/sh
# This script is called by the changeset action in release.yml.

set -e

pnpm exec changeset version

# `changeset version` bumps package.json versions but does not update pnpm-lock.yaml,
# so refresh the lockfile here or the next `pnpm install --frozen-lockfile` fails.
# `--lockfile-only` rewrites the lockfile without touching node_modules.
# See https://github.com/changesets/changesets/issues/421.
pnpm install --lockfile-only
