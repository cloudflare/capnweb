// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Fails the build if any runtime bundle in dist/ contains non-ASCII bytes.
//
// Consumers inline these bundles into `data:` URLs and similar wrappers, often
// through Latin-1-only APIs like btoa(), where a single non-ASCII character
// either throws or silently corrupts. Which source comments survive bundling
// is an implementation detail of the bundler, so the invariant is enforced on
// the built output rather than on source. Runtime strings that genuinely need
// non-ASCII characters can use \u escapes in source.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

const runtimeFiles = readdirSync(distDir).filter(
  (name) => /\.(js|cjs|mjs)$/.test(name) && !/\.d\.(ts|cts|mts)$/.test(name)
);

let failures = 0;
for (const name of runtimeFiles) {
  const text = readFileSync(join(distDir, name), "utf8");
  const match = /[^\x00-\x7F]/.exec(text);
  if (match) {
    const line = text.slice(0, match.index).split("\n").length;
    const char = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    console.error(`dist/${name}:${line}: non-ASCII character U+${char}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} dist file(s) contain non-ASCII characters. Replace them in the ` +
      `originating source (or use \\u escapes for runtime strings that need them).`
  );
  process.exit(1);
}
