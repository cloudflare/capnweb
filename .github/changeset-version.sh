#! /bin/sh
# This script is called by the changeset action in release.yml.

set -e

npx changeset version

# The standard step is only to run `changeset version` but this does not update the
# package-lock.json file. So we also run `npm install`, which does this update.
# This is a workaround until this is handled automatically by `changeset version`.
# See https://github.com/changesets/changesets/issues/421.
npm install
