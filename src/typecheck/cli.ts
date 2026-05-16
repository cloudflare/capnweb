#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Build-time CLI for Cap'n Web RPC validation codegen.
//
// `capnweb typecheck gen <input.ts>` extracts RpcTarget classes from <input.ts>
// and writes validators into the resolved `capnweb-typecheck` placeholder
// package. The capnweb runtime auto-loads from there by class name, so user
// code and bundler entry points stay untouched.
//
// `capnweb typecheck reset` restores the placeholder to its stub state, which
// disables runtime validation until the next `gen` run.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generate, generateForPackage, resetTypecheckPackage, type GenOptions } from "./generate.js";

function usage(exitCode = 1): never {
  let out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  capnweb typecheck gen <input.ts> [--out <dir>]
  capnweb typecheck reset

Examples:
  capnweb typecheck gen src/worker.ts
  capnweb typecheck gen src/worker.ts --out .capnweb   # legacy directory output
  capnweb typecheck reset                              # restore stub validators`);
  process.exit(exitCode);
}

async function main() {
  let [command, subcommand, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage(0);
  if (command !== "typecheck") usage();
  if (!subcommand || subcommand === "--help" || subcommand === "-h") usage(0);

  if (subcommand === "reset") {
    if (rest.length > 0) usage();
    resetTypecheckPackage();
    return;
  }

  if (subcommand !== "gen") usage();
  if (rest.includes("--help") || rest.includes("-h")) usage(0);

  let parsed = parseGenArgs(rest);
  if (parsed.outDir === undefined) {
    generateForPackage({ input: parsed.input });
  } else {
    generate({ input: parsed.input, outDir: parsed.outDir });
  }
}

function parseGenArgs(args: string[]): { input: string; outDir: string | undefined } {
  let input: string | undefined;
  let outDir: string | undefined;
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
