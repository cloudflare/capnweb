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

type EmitSide = "server" | "client";

// Emit a `const <name> = { serviceName, methods: { ... } };` declaration.
// References `__cw`; the transform adds the runtime import to each module.
export function emitValidator(
  bindingName: string,
  shape: ServiceShape,
  mode: ValidationMode = "throw",
  side: EmitSide = "server"
): string {
  let lines: string[] = [];
  let ctx: EmitContext = {
    bindingName,
    namedShapes: shape.namedShapes,
    definingId: undefined,
    mode,
    side,
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
  side: EmitSide;
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
    : `__cw.v.lazy(() => ${binding})`;
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
  let parts: string[] = [];
  if (ctx.side !== "client") {
    let args = method.params.map((p) => emitValidator_(p, ctx)).join(", ");
    parts.push(`args: [${args}]`);
    if (method.rest) parts.push(`rest: ${emitValidator_(method.rest, ctx)}`);
  }
  parts.push(`returns: ${emitValidator_(method.returns, ctx)}`);
  if (method.isGetter) parts.push(`isGetter: true`);
  return `{ ${parts.join(", ")} }`;
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
  if (shape.passthrough?.length)
    parts.push(`passthrough: ${JSON.stringify(shape.passthrough)}`);
  return parts;
}

function emitValidator_(shape: TypeShape, ctx: EmitContext): string {
  switch (shape.kind) {
    case "string":
      return `__cw.v.string`;
    case "number":
      return `__cw.v.number`;
    case "boolean":
      return `__cw.v.boolean`;
    case "bigint":
      return `__cw.v.bigint`;
    case "null":
      return `__cw.v.null_`;
    case "undefined":
      return `__cw.v.undefined_`;
    case "void":
      return `__cw.v.undefined_`;
    case "any":
      return `__cw.v.any`;
    case "literal":
      return `__cw.v.literal(${JSON.stringify(shape.value)})`;
    case "array": {
      let hoisted = hoistedBinding(shape, ctx);
      if (hoisted) return hoisted;
      return `__cw.v.array(${emitValidator_(shape.element, ctx)})`;
    }
    case "map":
      return `__cw.v.map(${emitValidator_(shape.key, ctx)}, ${emitValidator_(
        shape.value,
        ctx
      )})`;
    case "set":
      return `__cw.v.set(${emitValidator_(shape.element, ctx)})`;
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
      return `__cw.v.tuple([${elements}]${optsArg})`;
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
      return `__cw.v.object({ ${entries.join(", ")} }${nameArg}${indexArg})`;
    }
    case "union": {
      let hoisted = hoistedBinding(shape, ctx);
      if (hoisted) return hoisted;
      let branches = shape.branches
        .map((b) => emitValidator_(b, ctx))
        .join(", ");
      return `__cw.v.union([${branches}])`;
    }
    case "ref":
      return bindingRef(shape.id, ctx);
    // Built-in pass-by-value types. The runtime checks each by brand
    // (`instanceof`) since the wire deserialises real instances. Each kind name
    // matches its `v.*` validator, so map directly.
    case "date":
    case "arrayBuffer":
    case "dataView":
    case "regexp":
    case "bytes":
    case "error":
    case "blob":
    case "readableStream":
    case "writableStream":
    case "headers":
    case "request":
    case "response":
      return `__cw.v.${shape.kind}`;
    case "typedArray":
      return `__cw.v.typedArray(${JSON.stringify(shape.name)})`;
    // Pass-by-reference: keep the stub service shape so pipelined calls validate too.
    case "function":
      return `__cw.v.func`;
    case "stub":
      return shape.service
        ? `__cw.v.stubOf(${emitServiceLiteral(shape.service, ctx)})`
        : `__cw.v.stub`;
    case "unsupported":
      // Normally rejected before here; this fallback covers unrepresentable corners and keeps the lowerer total.
      return `__cw.v.any`;
  }
}
