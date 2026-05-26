#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Wrangler entry point. Runs the per-module transform across a TS project
// and writes the rewritten output under `--out`, which the user points
// Wrangler at via a `predev` / `prebuild` script.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runBuild } from "./transform/run.js";

function usage(exitCode: number = 1): never {
  let out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  capnweb-typecheck build --out <dir> [--tsconfig <path>] [--cwd <dir>]

Options:
  --out <dir>        Directory to write transformed sources to. Required.
  --tsconfig <path>  Path to tsconfig.json. Defaults to ./tsconfig.json.
  --cwd <dir>        Working directory. Defaults to process.cwd().
  -h, --help         Show this message.`);
  process.exit(exitCode);
}

type BuildArgs = {
  out?: string;
  tsconfig?: string;
  cwd?: string;
};

function parseBuildArgs(args: string[]): BuildArgs {
  let parsed: BuildArgs = {};
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    } else if (arg === "--out" || arg === "--tsconfig" || arg === "--cwd") {
      let value = args[++i];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      parsed[arg.slice(2) as "out" | "tsconfig" | "cwd"] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  let [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h") {
    usage(command === undefined ? 1 : 0);
  }
  if (command !== "build") {
    throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
  let opts = parseBuildArgs(rest);
  if (!opts.out) {
    throw new Error(
        "Missing --out <dir>. Specify where to write transformed sources.");
  }
  let result = await runBuild({
    out: opts.out,
    tsconfig: opts.tsconfig,
    cwd: opts.cwd,
  });
  console.log(
      `capnweb-typecheck: ${result.transformed} transformed, ` +
      `${result.copied} copied -> ${opts.out}`);
}

if (isMain()) {
  main().catch((err) => {
    let message = err instanceof Error ? err.message : String(err);
    console.error(`capnweb-typecheck: ${message}`);
    process.exit(1);
  });
}

function isMain(): boolean {
  let entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
