// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

export type PrimitiveName = "string" | "number" | "bigint" | "boolean" | "undefined" | "null" | "void";

export type TypeSpec =
  | { kind: "any" }
  | { kind: "primitive", name: PrimitiveName }
  | { kind: "literal", value: string | number | boolean }
  | { kind: "array", element: TypeSpec }
  | { kind: "tuple", elements: TypeSpec[] }
  | { kind: "map", key: TypeSpec, value: TypeSpec }
  | { kind: "set", value: TypeSpec }
  | { kind: "object", props: ObjectProp[] }
  | { kind: "record", value: TypeSpec }
  | { kind: "union", variants: TypeSpec[] }
  | { kind: "instance", name: string }
  | { kind: "rpcTarget" }
  | { kind: "stub" }
  | { kind: "function" }
  | { kind: "never" }
  | { kind: "unsupported", text: string }
  // Reference to a hoisted named validator. Used for recursive types
  // (e.g. `type JsonValue = ... | JsonValue[]`) so the validator can be
  // emitted once and call itself instead of being inlined infinitely.
  | { kind: "ref", id: string };

export type ObjectProp = { name: string, optional: boolean, type: TypeSpec };
export type ParamSpec = { name: string, optional: boolean, type: TypeSpec };
export type MethodSpec = { name: string, params: ParamSpec[], returns: TypeSpec };

export type ClassRegistration = {
  name: string;
  valueName: string;
  isDefault: boolean;
  sourcePath: string;
};

export type ExtractedClassSpec = ClassRegistration & { methods: MethodSpec[] };

export type GenResult = {
  classes: string[];
  registrations: ClassRegistration[];
};

export type GenOptions = {
  input: string;
  outDir: string;
  /** @internal Override the import emitted in generated modules. */
  runtimeImport?: string;
};
