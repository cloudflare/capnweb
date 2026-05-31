// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Emit JS source for a `ServiceValidator` from a resolved ServiceShape.

import type { ValidationMode } from "../internal/core.js";
import type {
  MethodShape,
  ServiceShape,
  TypeShape,
} from "./type-introspector.js";

// Emit a `const <name> = { serviceName, methods: { ... } };` declaration.
// References `__rt`; the transform adds the runtime import to each module.
export function emitValidator(
  bindingName: string,
  shape: ServiceShape,
  mode: ValidationMode = "throw"
): string {
  let lines: string[] = [];
  let ctx: EmitContext = {
    bindingName,
    namedShapes: shape.namedShapes,
    definingId: undefined,
    mode,
  };
  for (let id of shape.namedShapes.keys()) {
    lines.push(`let ${shapeBinding(bindingName, id)};`);
  }
  for (let [id, namedShape] of shape.namedShapes) {
    ctx.definingId = id;
    lines.push(
      `${shapeBinding(bindingName, id)} = ${emitValidator_(namedShape, ctx)};`
    );
  }
  ctx.definingId = undefined;
  lines.push(`const ${bindingName} = {`);
  for (let part of serviceMetaParts(shape, mode)) lines.push(`  ${part},`);
  lines.push(`  methods: {`);
  for (let method of shape.methods) {
    lines.push(
      `    ${JSON.stringify(method.name)}: ${emitMethod(method, ctx)},`
    );
  }
  lines.push(`  },`);
  lines.push(`};`);
  return lines.join("\n");
}

type EmitContext = {
  bindingName: string;
  namedShapes: Map<number, TypeShape>;
  definingId: number | undefined;
  mode: ValidationMode;
};

function shapeBinding(bindingName: string, id: number): string {
  return `${bindingName}_shape_${id}`;
}

function hoistedBinding(shape: TypeShape, ctx: EmitContext): string | null {
  let id = shapeId(shape);
  if (id === undefined || id === ctx.definingId || !ctx.namedShapes.has(id)) {
    return null;
  }
  return bindingRef(id, ctx);
}

// Inside a named shape body the target may be forward/cyclic, so defer with
// `lazy`; at method level all shapes are assigned, so reference directly.
function bindingRef(id: number, ctx: EmitContext): string {
  let binding = shapeBinding(ctx.bindingName, id);
  return ctx.definingId === undefined
    ? binding
    : `__rt.v.lazy(() => ${binding})`;
}

function shapeId(shape: TypeShape): number | undefined {
  switch (shape.kind) {
    case "array":
    case "tuple":
    case "object":
    case "union":
      return shape.id;
    default:
      return undefined;
  }
}

function emitMethod(method: MethodShape, ctx: EmitContext): string {
  if (method.skipValidation) return `{ unchecked: true }`;
  let args = method.params.map((p) => emitValidator_(p, ctx)).join(", ");
  let rest = method.rest ? `, rest: ${emitValidator_(method.rest, ctx)}` : "";
  let getter = method.isGetter ? `, isGetter: true` : "";
  return `{ args: [${args}]${rest}, returns: ${emitValidator_(
    method.returns,
    ctx
  )}${getter} }`;
}

function emitServiceLiteral(shape: ServiceShape, ctx: EmitContext): string {
  let methods = shape.methods
    .map(
      (method) => `${JSON.stringify(method.name)}: ${emitMethod(method, ctx)}`
    )
    .join(", ");
  let meta = serviceMetaParts(shape, ctx.mode).join(", ");
  return `({ ${meta}, methods: { ${methods} } })`;
}

// The ServiceValidator metadata fields (`serviceName`, optional `targetKind`,
// optional non-default `mode`) shared by the hoisted binding and the inline
// stub literal. Each part is a `key: value` fragment.
function serviceMetaParts(shape: ServiceShape, mode: ValidationMode): string[] {
  let parts = [`serviceName: ${JSON.stringify(shape.name)}`];
  if (shape.targetKind)
    parts.push(`targetKind: ${JSON.stringify(shape.targetKind)}`);
  if (mode !== "throw") parts.push(`mode: ${JSON.stringify(mode)}`);
  return parts;
}

function emitValidator_(shape: TypeShape, ctx: EmitContext): string {
  switch (shape.kind) {
    case "string":
      return `__rt.v.string`;
    case "number":
      return `__rt.v.number`;
    case "boolean":
      return `__rt.v.boolean`;
    case "bigint":
      return `__rt.v.bigint`;
    case "null":
      return `__rt.v.null_`;
    case "undefined":
      return `__rt.v.undefined_`;
    case "void":
      return `__rt.v.undefined_`;
    case "any":
      return `__rt.v.any`;
    case "literal":
      return `__rt.v.literal(${JSON.stringify(shape.value)})`;
    case "array": {
      let hoisted = hoistedBinding(shape, ctx);
      if (hoisted) return hoisted;
      return `__rt.v.array(${emitValidator_(shape.element, ctx)})`;
    }
    case "tuple": {
      let hoisted = hoistedBinding(shape, ctx);
      if (hoisted) return hoisted;
      let elements = shape.elements
        .map((e) => emitValidator_(e, ctx))
        .join(", ");
      let opts: string[] = [];
      if (
        shape.minLength !== undefined &&
        shape.minLength !== shape.elements.length
      ) {
        opts.push(`minLength: ${shape.minLength}`);
      }
      if (shape.rest) {
        opts.push(`rest: ${emitValidator_(shape.rest, ctx)}`);
      }
      let optsArg = opts.length ? `, { ${opts.join(", ")} }` : "";
      return `__rt.v.tuple([${elements}]${optsArg})`;
    }
    case "object": {
      let hoisted = hoistedBinding(shape, ctx);
      if (hoisted) return hoisted;
      let entries = Object.entries(shape.properties).map(
        ([key, value]) =>
          `${JSON.stringify(key)}: ${emitValidator_(value, ctx)}`
      );
      let nameArg = shape.name ? `, ${JSON.stringify(shape.name)}` : "";
      let indexArg = shape.index
        ? `${shape.name ? "" : ", undefined"}, ${emitValidator_(
            shape.index,
            ctx
          )}`
        : "";
      return `__rt.v.object({ ${entries.join(", ")} }${nameArg}${indexArg})`;
    }
    case "union": {
      let hoisted = hoistedBinding(shape, ctx);
      if (hoisted) return hoisted;
      let branches = shape.branches
        .map((b) => emitValidator_(b, ctx))
        .join(", ");
      return `__rt.v.union([${branches}])`;
    }
    case "ref":
      return bindingRef(shape.id, ctx);
    // Built-in pass-by-value types. The runtime checks each by brand
    // (`instanceof`) since the wire deserialises real instances. Each kind name
    // matches its `v.*` validator, so map directly.
    case "date":
    case "bytes":
    case "error":
    case "blob":
    case "readableStream":
    case "writableStream":
    case "headers":
    case "request":
    case "response":
      return `__rt.v.${shape.kind}`;
    // Pass-by-reference: keep the stub service shape so pipelined calls validate too.
    case "function":
      return `__rt.v.func`;
    case "stub":
      return shape.service
        ? `__rt.v.stubOf(${emitServiceLiteral(shape.service, ctx)})`
        : `__rt.v.stub`;
    case "unsupported":
      // Normally rejected before here; this fallback covers unrepresentable corners and keeps the lowerer total.
      return `__rt.v.any`;
  }
}
