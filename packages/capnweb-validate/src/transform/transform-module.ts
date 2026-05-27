// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Per-module transform for marker imports from "capnweb-validate". It
// resolves the service type, emits a private validator, imports the internal
// runtime, and rewrites marker calls to runtime helpers.

import ts from "typescript";

import type { TransformContext } from "./context.js";
import { emitValidator } from "./emit.js";
import {
  collectUnsupported,
  resolveServiceShape,
  type ServiceShape,
  type TypeShape,
} from "./type-introspector.js";

export type TransformResult = {
  code: string;
};

type TextEdit = {
  start: number;
  end: number;
  text: string;
};

function applyTextEdits(code: string, edits: TextEdit[]): string {
  // The transform emits plain code without a source map. The CLI writes the
  // transformed files to disk, and plugin users see diagnostics in the
  // transformed module.
  let ordered = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  assertValidTextEdits(code, ordered);

  let out = code;
  for (let edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function assertValidTextEdits(code: string, ordered: TextEdit[]): void {
  for (let edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > code.length) {
      throw new Error(`capnweb-validate: invalid text edit [${edit.start},${edit.end})`);
    }
  }
  for (let i = 1; i < ordered.length; i++) {
    let right = ordered[i - 1]!;
    let left = ordered[i]!;
    if (left.start === right.start && left.end === right.end) {
      throw new Error(`capnweb-validate: duplicate text edit at ${left.start}`);
    }
    if (left.end > right.start) {
      throw new Error(
        `capnweb-validate: overlapping text edits ` +
        `[${left.start},${left.end}) and [${right.start},${right.end})`,
      );
    }
  }
}

/**
 * Marker imports we recognise. `side` picks which Proxy to install (server
 * wraps the target; client wraps the returned stub). `form` distinguishes
 * factory calls (`fn(...)`) from the one constructor (`new RpcSession<T>(...)`).
 * `targetArgIndex` only matters on the server side; client sites read the
 * service type from the call's type argument / return type instead.
 */
const MARKERS: Record<string, {
  side: "server" | "client";
  helper: string;
  targetArgIndex: number;
  form: "call" | "new";
}> = {
  // Server boundaries: target argument is the user's RpcTarget instance.
  newWorkersRpcResponse:           { side: "server", form: "call", helper: "__newWorkersRpcResponsewithValidation",           targetArgIndex: 1 },
  newWorkersWebSocketRpcResponse:  { side: "server", form: "call", helper: "__newWorkersWebSocketRpcResponsewithValidation",  targetArgIndex: 1 },
  newHttpBatchRpcResponse:         { side: "server", form: "call", helper: "__newHttpBatchRpcResponsewithValidation",         targetArgIndex: 1 },
  nodeHttpBatchRpcResponse:        { side: "server", form: "call", helper: "__nodeHttpBatchRpcResponsewithValidation",        targetArgIndex: 2 },
  // Client sessions: the remote service type is the explicit type argument
  // (or contextual). The call's return type is `RpcStub<T>`.
  newHttpBatchRpcSession:    { side: "client", form: "call", helper: "__newHttpBatchRpcSessionwithValidation",    targetArgIndex: -1 },
  newWebSocketRpcSession:    { side: "client", form: "call", helper: "__newWebSocketRpcSessionwithValidation",    targetArgIndex: -1 },
  newMessagePortRpcSession:  { side: "client", form: "call", helper: "__newMessagePortRpcSessionwithValidation",  targetArgIndex: -1 },
  // The one constructor form: `new RpcSession<T>(transport)` becomes a plain
  // call to a helper that returns a session-shaped Proxy (so users keep
  // `.getRemoteMain()` / `.drain()` etc). Return type of the call is the
  // session itself, not `RpcStub<T>`, so the client resolver unwraps the
  // session's `getRemoteMain` return rather than the call return directly.
  RpcSession:                { side: "client", form: "new",  helper: "__newRpcSessionwithValidation",              targetArgIndex: -1 },
};

const PACKAGE_NAME = "capnweb-validate";
const RUNTIME_NAMESPACE = "__rt";
const RUNTIME_IMPORT = `import * as ${RUNTIME_NAMESPACE} from "${PACKAGE_NAME}/internal";\n`;

export function transformModule(
    context: TransformContext, id: string, code: string): TransformResult | null {
  // Fast bail-out: handled by the plugin too, but cheap to re-check.
  if (!code.includes(PACKAGE_NAME)) return null;

  let sourceFile = context.getSourceFile(id);
  if (!sourceFile) {
    // The file isn't in the Program (e.g. it's a virtual module Vite handed
    // us that tsc never saw). Skip rather than fabricate a parse.
    return null;
  }
  let checker = context.getChecker();

  // Step 2: collect marker bindings imported from the package.
  let bindings = collectMarkerBindings(sourceFile);
  if (bindings.size === 0) return null;

  // Step 3+4: find call sites and resolve service shapes.
  let callSites = collectCallSites(sourceFile, bindings, checker);
  if (callSites.length === 0) return null;

  // Step 5: dedup validators by (serviceName, side). Same-name collisions
  // within a module across distinct types are resolved with a numeric suffix.
  let dedup = new ValidatorDedup();
  for (let cs of callSites) {
    cs.bindingName = dedup.bind(cs.shape, cs.side);
  }

  let edits: TextEdit[] = [];

  // Prepend the runtime import and emitted validators. Source outside this
  // prelude is left intact.
  let prelude = RUNTIME_IMPORT;
  for (let entry of dedup.emitOrder()) {
    prelude += emitValidator(entry.bindingName, entry.shape) + "\n";
  }
  edits.push({ start: 0, end: 0, text: prelude });

  // Rewrite each call site:  marker(...args)  →  __rt.helper(...args, validator)
  // The same rewrite handles the `new RpcSession<T>(...)` form because we
  // overwrite from `new`'s start through the callee identifier's end, turning
  // the whole NewExpression head into a function call. Type arguments and
  // the original argument list (including any trailing whitespace / comments
  // we don't want to disturb) survive untouched.
  for (let cs of callSites) {
    let callee = cs.call.expression;
    let headStart = cs.marker.form === "new"
        ? cs.call.getStart(sourceFile)   // includes the `new ` keyword
        : callee.getStart(sourceFile);
    edits.push({
      start: headStart,
      end: callee.getEnd(),
      text: `${RUNTIME_NAMESPACE}.${cs.marker.helper}`,
    });
    // Append the validator before the closing paren. NewExpression may omit
    // parens entirely (`new Foo`); the resolver rejected those upstream, so
    // by this point `arguments` is defined and the call ends with `)`.
    let closeParenPos = cs.call.getEnd() - 1;
    let hasArgs = (cs.call.arguments?.length ?? 0) > 0;
    let insertion = hasArgs ? `, ${cs.bindingName!}` : `${cs.bindingName!}`;
    edits.push({ start: closeParenPos, end: closeParenPos, text: insertion });
  }

  return { code: applyTextEdits(code, edits) };
}

// ---------------------------------------------------------------------------
// Step 2: marker bindings.
// ---------------------------------------------------------------------------

type MarkerBinding = {
  /** Local name as used in this file (after `import { foo as bar }`). */
  localName: string;
  /** The marker as exported by the package. */
  markerName: keyof typeof MARKERS;
};

function collectMarkerBindings(sf: ts.SourceFile): Map<string, MarkerBinding> {
  let result = new Map<string, MarkerBinding>();
  for (let stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    let mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod) || mod.text !== PACKAGE_NAME) continue;
    let clause = stmt.importClause;
    if (!clause || !clause.namedBindings) continue;
    if (!ts.isNamedImports(clause.namedBindings)) continue;
    for (let spec of clause.namedBindings.elements) {
      let imported = (spec.propertyName ?? spec.name).text;
      if (!(imported in MARKERS)) continue;
      result.set(spec.name.text, {
        localName: spec.name.text,
        markerName: imported as keyof typeof MARKERS,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 3 + 4: call sites + service shape resolution.
// ---------------------------------------------------------------------------

type CallSite = {
  /**
   * Either `marker(...)` or `new RpcSession<T>(...)`. Both nodes expose the
   * same `expression` / `typeArguments` / `arguments` / position APIs the
   * rewriter uses, so the rest of the pipeline doesn't branch on form.
   */
  call: ts.CallExpression | ts.NewExpression;
  marker: (typeof MARKERS)[keyof typeof MARKERS];
  side: "server" | "client";
  shape: ServiceShape;
  /** Filled in during dedup. */
  bindingName?: string;
};

function collectCallSites(
    sf: ts.SourceFile,
    bindings: Map<string, MarkerBinding>,
    checker: ts.TypeChecker): CallSite[] {
  let out: CallSite[] = [];

  function visit(node: ts.Node): void {
    // Both call and new sites share the same identifier-callable shape; the
    // marker entry's `form` tells us which one we expect. A `new` site
    // without parens (`new RpcSession`) is rejected as unresolvable because
    // we can't append a validator with no argument list to anchor on.
    let isCall = ts.isCallExpression(node) && ts.isIdentifier(node.expression);
    let isNew  = ts.isNewExpression(node)  && ts.isIdentifier(node.expression)
                  && node.arguments !== undefined;
    if (isCall || isNew) {
      let call = node as ts.CallExpression | ts.NewExpression;
      let binding = bindings.get((call.expression as ts.Identifier).text);
      if (binding) {
        let marker = MARKERS[binding.markerName];
        let expected = marker.form;
        let actual: "call" | "new" = isNew ? "new" : "call";
        // Mismatch is a real user error - `new newWorkersRpcResponse(...)`
        // or calling `RpcSession(...)` without `new` both leave us nothing
        // sensible to do. Fall through (don't push) so TypeScript surfaces
        // the underlying signature error instead of a confusing transform
        // error; the value-side import is `uncompiledMarker`, which throws
        // at runtime if a misuse somehow reaches it.
        if (expected !== actual) {
          ts.forEachChild(node, visit);
          return;
        }
        let shape = resolveCallSiteShape(call, marker, checker);
        if (shape === null) {
          let hint = marker.side === "server"
            ? `Annotate the target argument with a specific RPC service type ` +
              `(e.g. \`new MyApi(env)\` or \`const target: MyApi = ...\`).`
            : marker.form === "new"
              ? `Annotate the constructor with a specific RPC service type ` +
                `(e.g. \`new ${binding.localName}<MyApi>(transport)\`).`
              : `Annotate the call with a specific RPC service type ` +
                `(e.g. \`${binding.localName}<MyApi>("/rpc")\` or ` +
                `\`const api: RpcStub<MyApi> = ...\`).`;
          throw buildError(sf, call,
            `capnweb-validate: could not resolve a concrete service type for ` +
            `\`${binding.localName}(...)\`. ${hint}`,
          );
        }
        let bad = collectUnsupported(shape);
        if (bad.length > 0) {
          // List every offending leaf so the user can fix them in one pass
          // rather than rebuilding once per field.
          let detail = bad.map(b => `  - ${b.path}: ${b.reason}`).join("\n");
          throw buildError(sf, call,
            `capnweb-validate: \`${binding.localName}(...)\` references types ` +
            `that capnweb cannot transport. Fix or replace these fields:\n${detail}`,
          );
        }
        out.push({ call, marker, side: marker.side, shape });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

function resolveCallSiteShape(
    call: ts.CallExpression | ts.NewExpression,
    marker: (typeof MARKERS)[keyof typeof MARKERS],
    checker: ts.TypeChecker): ServiceShape | null {
  let type: ts.Type;
  if (marker.side === "server") {
    let arg = call.arguments?.[marker.targetArgIndex];
    if (!arg) return null;
    type = checker.getTypeAtLocation(arg);
  } else if (marker.form === "new") {
    // `new RpcSession<T>(transport)` names the service directly. Prefer the
    // explicit type argument because real capnweb aliases `RpcStub<T>` to an
    // intersection type, so return-type unwrapping cannot always recover `T`.
    let explicit = getExplicitTypeArgument(call, checker);
    if (explicit) {
      type = unwrapRpcStub(checker, explicit);
    } else {
      let sig = checker.getResolvedSignature(call);
      if (!sig) return null;
      let session = checker.getReturnTypeOfSignature(sig);
      let args = checker.getTypeArguments(session as ts.TypeReference);
      if (args.length !== 1) return null;
      type = unwrapRpcStub(checker, args[0]!);
    }
  } else {
    // Client factory calls normally name the remote service as
    // `newHttpBatchRpcSession<Api>(...)`. Fall back to the resolved return
    // type for declarations that can still expose an unexpanded `RpcStub<T>`.
    let explicit = getExplicitTypeArgument(call, checker);
    if (explicit) {
      type = unwrapRpcStub(checker, explicit);
    } else {
      let sig = checker.getResolvedSignature(call);
      if (!sig) return null;
      let ret = checker.getReturnTypeOfSignature(sig);
      let unwrapped = unwrapRpcStub(checker, ret);
      if (unwrapped === ret) return null;
      type = unwrapped;
    }
  }
  // Skip purely generic / non-specific types (parameters, unknowns, etc.).
  if (isTooGeneric(type)) return null;
  return resolveServiceShape(ts, checker, type);
}

function getExplicitTypeArgument(
    call: ts.CallExpression | ts.NewExpression, checker: ts.TypeChecker): ts.Type | null {
  let arg = call.typeArguments?.[0];
  return arg ? checker.getTypeFromTypeNode(arg) : null;
}

function unwrapRpcStub(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  let sym = type.getSymbol();
  if (sym && (sym.getName() === "RpcStub" || sym.getName() === "RpcPromise")) {
    let args = checker.getTypeArguments(type as ts.TypeReference);
    if (args.length === 1) return args[0]!;
  }
  return type;
}

function isTooGeneric(type: ts.Type): boolean {
  let flags = type.getFlags();
  // Bare type parameters, `any`, `unknown`, `never`, and `RpcTarget` itself
  // all fail to identify a concrete service. `unknown` is what you get from
  // a client call with no explicit type argument and no inference source.
  if (flags & ts.TypeFlags.TypeParameter) return true;
  if (flags & ts.TypeFlags.Any) return true;
  if (flags & ts.TypeFlags.Unknown) return true;
  if (flags & ts.TypeFlags.Never) return true;
  let name = type.getSymbol()?.getName();
  if (name === "RpcTarget") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Step 5: dedup.
// ---------------------------------------------------------------------------

class ValidatorDedup {
  /** Key: `<side>:<serviceName>`. Distinct shapes with the same name get suffixed. */
  #emitted = new Map<string, { bindingName: string; shape: ServiceShape; signature: string }[]>();
  #order: { bindingName: string; shape: ServiceShape }[] = [];

  bind(shape: ServiceShape, side: "server" | "client"): string {
    let key = `${side}:${shape.name}`;
    let entries = this.#emitted.get(key) ?? [];
    let signature = serviceSignature(shape);
    let existing = entries.find((entry) => entry.signature === signature);
    if (existing) return existing.bindingName;
    let suffix = entries.length === 0 ? "" : `_${entries.length + 1}`;
    let bindingName = `__capnweb_typecheck_${sanitize(shape.name)}_${side}${suffix}`;
    let entry = { bindingName, shape, signature };
    entries.push(entry);
    this.#emitted.set(key, entries);
    this.#order.push(entry);
    return bindingName;
  }

  emitOrder(): { bindingName: string; shape: ServiceShape }[] {
    return this.#order;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function serviceSignature(shape: ServiceShape): string {
  return JSON.stringify(shape.methods.map((method) => method.skipValidation ? {
    name: method.name,
    unchecked: true,
  } : {
    name: method.name,
    params: method.params.map((param) => typeSignature(param)),
    rest: method.rest ? typeSignature(method.rest) : null,
    returns: typeSignature(method.returns),
  }));
}

function typeSignature(shape: TypeShape): unknown {
  switch (shape.kind) {
    case "literal":
      return [shape.kind, shape.value];
    case "array":
      return [shape.kind, typeSignature(shape.element)];
    case "tuple":
      return [shape.kind, shape.elements.map((element) => typeSignature(element))];
    case "object":
      return [shape.kind, shape.name, sortedEntries(shape.properties),
        shape.index ? typeSignature(shape.index) : null];
    case "union":
      return [shape.kind, shape.branches.map((branch) => typeSignature(branch))];
    case "ref":
      return [shape.kind, shape.id];
    case "stub":
      return [shape.kind, shape.service ? serviceSignature(shape.service) : null];
    case "unsupported":
      return [shape.kind, shape.reason];
    default:
      return [shape.kind];
  }
}

function sortedEntries(properties: Record<string, TypeShape>): unknown[] {
  return Object.entries(properties)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, typeSignature(value)]);
}

// ---------------------------------------------------------------------------
// Error formatting.
// ---------------------------------------------------------------------------

function buildError(sf: ts.SourceFile, node: ts.Node, message: string): Error {
  let { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return new Error(`${sf.fileName}:${line + 1}:${character + 1}: ${message}`);
}
