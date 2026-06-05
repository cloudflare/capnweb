#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Wrangler entry point. Runs the per-module transform across a TS project
// and writes the rewritten output under `--out`, which the user points
// Wrangler at via a `predev` / `prebuild` script.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ValidationMode } from "./internal/core.js";
import { runBuild } from "./transform/run.js";

function usage(exitCode: number = 1): never {
  let out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  capnweb-validate build --out <dir> [options]

Options:
  --out <dir>                 Directory to write transformed sources to. Required.
  --tsconfig <path>           Path to tsconfig.json. Defaults to ./tsconfig.json.
  --cwd <dir>                 Working directory. Defaults to process.cwd().
  --server-validation <mode>  How server-side checks behave: throw | warn. Default throw.
  -h, --help                  Show this message.`);
  process.exit(exitCode);
}

type BuildArgs = {
  out?: string;
  tsconfig?: string;
  cwd?: string;
  serverValidation?: ValidationMode;
};

function parseMode(arg: string, value: string | undefined): ValidationMode {
  if (value === undefined) throw new Error(`${arg} requires a value.`);
  if (value !== "throw" && value !== "warn") {
    throw new Error(`${arg} must be one of throw, warn (got ${value}).`);
  }
  return value;
}

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
    } else if (arg === "--server-validation") {
      parsed.serverValidation = parseMode(arg, args[++i]);
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
    serverValidation: opts.serverValidation,
  });
  console.log(
      `capnweb-validate: ${result.transformed} transformed, ` +
      `${result.copied} copied` +
      (result.skipped ? `, ${result.skipped} skipped (outside project)` : "") +
      ` -> ${opts.out}`);
}

if (isMain()) {
  main().catch((err) => {
    let message = err instanceof Error ? err.message : String(err);
    console.error(`capnweb-validate: ${message}`);
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
