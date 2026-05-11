// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Tooling-only option / result shapes. The validator data types and helpers
// are produced by Typia at build time and registered through
// `capnweb/internal/typecheck`; this file only describes the API surface of
// the generator itself.

export type ClassRegistration = {
  name: string;
  valueName: string;
  isDefault: boolean;
  sourcePath: string;
};

export type GenResult = {
  classes: string[];
  registrations: ClassRegistration[];
};

export type GenOptions = {
  input: string;
  outDir: string;
  /**
   * @internal Override the package import emitted in generated modules.
   * Defaults to `"capnweb/internal/typecheck"`. Test infrastructure points it
   * at the in-tree runtime source so generated code can run before the
   * package is built.
   */
  runtimeImport?: string;
};
