// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit
//
// Vendored helpers from `typia/lib/internal/`. Typia is MIT licensed
// (Copyright 2020 Jeongho Nam <samchon.github@gmail.com>); the original
// source lives in https://github.com/samchon/typia. We vendor these two
// tiny dependency-free helpers so that generated validators -- produced at
// build time by `capnweb-typecheck` and shipped in the user's app -- do not
// pull `typia` into the runtime bundle.

export type TypiaValidationError = {
  path: string;
  expected: string;
  value: unknown;
  description?: string;
};

export type TypiaValidationResult =
  | { success: true; data: unknown }
  | { success: false; errors: TypiaValidationError[]; data: unknown };

// Builds a "reporter" that the generated validator code calls for each
// observed mismatch. Mirrors typia/lib/internal/_validateReport.
export const _validateReport = (array: TypiaValidationError[]) => {
  const reportable = (path: string) => {
    if (array.length === 0) return true;
    const last = array[array.length - 1].path;
    return path.length > last.length || last.substring(0, path.length) !== path;
  };
  return (exceptable: boolean, error: TypiaValidationError) => {
    if (exceptable && reportable(error.path)) {
      if (error.value === undefined) {
        error.description ??= [
          "The value at this path is `undefined`.",
          "",
          `Please fill the \`${error.expected}\` typed value next time.`,
        ].join("\n");
      }
      array.push(error);
    }
    return false;
  };
};

// Attaches a Standard Schema (https://standardschema.dev) interface to a typia
// validator. Mirrors typia/lib/internal/_createStandardSchema with a simpler
// path representation -- generated validators only call into this when the
// host wants Standard Schema interop, and our wrapper consumes typia's native
// error format directly, so we don't need typia's full path parser here.
export const _createStandardSchema = (
    fn: (input: unknown) => TypiaValidationResult): typeof fn => {
  return Object.assign(fn, {
    "~standard": {
      version: 1,
      vendor: "capnweb",
      validate: (input: unknown) => {
        const result = fn(input);
        if (result.success) return { value: result.data };
        return {
          issues: result.errors.map(e => ({
            message: `expected ${e.expected}, got ${typeof e.value}`,
            path: e.path.split(/[.\[\]"]+/).filter(Boolean),
          })),
        };
      },
    },
  });
};
