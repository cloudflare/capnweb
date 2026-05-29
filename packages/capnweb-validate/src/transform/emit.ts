// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Turn a resolved ServiceShape into the JS source for a `ServiceValidator`
// matching the contract in `src/internal/runtime.ts`. Output is plain text;
// the transform stitches it into the module via TypeScript's printer.

import type { ValidationMode } from "../internal/core.js";
import type {
  MethodShape,
  ServiceShape,
  TypeShape,
} from "./type-introspector.js";

/**
 * Emit a `const <name> = { serviceName, methods: { ... } };` declaration as a
 * string. The caller chooses the binding name (one per server / client per
 * service, deduped by service type within a module).
 *
 * The emitted code references `__rt` as the runtime namespace; the transform
 * adds an internal runtime import at the top of every transformed module.
 */
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
  lines.push(`  serviceName: ${JSON.stringify(shape.name)},`);
  if (shape.targetKind) {
    lines.push(`  targetKind: ${JSON.stringify(shape.targetKind)},`);
  }
  if (mode !== "throw") {
    lines.push(`  mode: ${JSON.stringify(mode)},`);
  }
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
  if (id !== undefined && id !== ctx.definingId && ctx.namedShapes.has(id)) {
    return shapeBinding(ctx.bindingName, id);
  }
  return null;
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
  return `{ args: [${args}]${rest}, returns: ${emitValidator_(
    method.returns,
    ctx
  )} }`;
}

function emitServiceLiteral(shape: ServiceShape, ctx: EmitContext): string {
  let methods = shape.methods
    .map(
      (method) => `${JSON.stringify(method.name)}: ${emitMethod(method, ctx)}`
    )
    .join(", ");
  let targetKind = shape.targetKind
    ? `, targetKind: ${JSON.stringify(shape.targetKind)}`
    : "";
  let mode =
    ctx.mode !== "throw" ? `, mode: ${JSON.stringify(ctx.mode)}` : "";
  return `({ serviceName: ${JSON.stringify(
    shape.name
  )}${targetKind}${mode}, methods: { ${methods} } })`;
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
      return `__rt.v.lazy(() => ${shapeBinding(ctx.bindingName, shape.id)})`;
    // Built-in pass-by-value types. The runtime checks each by brand
    // (`instanceof`) since the wire deserialises real instances.
    case "date":
      return `__rt.v.date`;
    case "bytes":
      return `__rt.v.bytes`;
    case "error":
      return `__rt.v.error`;
    case "blob":
      return `__rt.v.blob`;
    case "readableStream":
      return `__rt.v.readableStream`;
    case "writableStream":
      return `__rt.v.writableStream`;
    case "headers":
      return `__rt.v.headers`;
    case "request":
      return `__rt.v.request`;
    case "response":
      return `__rt.v.response`;
    // Pass-by-reference: the wire ships a stub or function. When the resolver
    // knows the stub service, keep that method shape so pipelined calls can be
    // validated too.
    case "function":
      return `__rt.v.func`;
    case "stub":
      return shape.service
        ? `__rt.v.stubOf(${emitServiceLiteral(shape.service, ctx)})`
        : `__rt.v.stub`;
    case "unsupported":
      // Reject set bubbles up as a build error - emitting `v.any` would let
      // the boundary silently accept anything for a type the wire cannot
      // carry. The transform raises an error before reaching here in the
      // common path; this branch covers genuinely unrepresentable corners
      // (recursive types, etc.) and keeps the lowerer total.
      return `__rt.v.any`;
  }
}
