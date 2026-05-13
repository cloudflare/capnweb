#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Build-time CLI for Cap'n Web RPC validation codegen. Intended for builds
// that can point a bundler at a generated entry file -- Wrangler is the
// reference target. It writes validators, client wrappers, a shadow source
// tree, and a worker entry module under the configured output directory.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generate, type GenOptions } from "./generate.js";

function usage(exitCode = 1): never {
  let out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  capnweb typecheck gen <input.ts> [--out <dir>]

Example:
  capnweb typecheck gen src/worker.ts --out .capnweb`);
  process.exit(exitCode);
}

async function main() {
  let [command, subcommand, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage(0);
  if (command !== "typecheck") usage();
  if (!subcommand || subcommand === "--help" || subcommand === "-h") usage(0);
  if (subcommand !== "gen") usage();

  if (rest.includes("--help") || rest.includes("-h")) usage(0);
  let options = parseGenArgs(rest);
  generate(options);
}

function parseGenArgs(args: string[]): GenOptions {
  let input: string | undefined;
  let outDir = ".capnweb";
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === "--out" || arg === "-o") {
      let value = args[++i];
      if (value === undefined) throw new Error(`${arg} requires a directory argument.`);
      outDir = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!input) {
      input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!input) usage();
  return { input, outDir };
}

if (isMain()) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
