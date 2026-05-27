// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Per-module transform for capnweb-validate decorators and Cap'n Web client
// session calls. It resolves service types, emits private validators, imports
// the internal runtime, and rewrites marker syntax to runtime helpers.

import ts from "typescript";

import type { TransformContext } from "./context.js";
import { emitValidator } from "./emit.js";
import {
  collectUnsupported,
  isWorkerEntrypointType,
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
  let ordered = edits
    .slice()
    .sort((a, b) => b.start - a.start || b.end - a.end);
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
      throw new Error(
        `capnweb-validate: invalid text edit [${edit.start},${edit.end})`
      );
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
          `[${left.start},${left.end}) and [${right.start},${right.end})`
      );
    }
  }
}

const PACKAGE_NAME = "capnweb-validate";
const CAPNWEB_MARKER_PACKAGE_NAME = "capnweb-validate/capnweb";
const CAPNWEB_PACKAGE_NAME = "capnweb";
const RUNTIME_NAMESPACE = "__rt";

const CORE_RUNTIME_IMPORT = `import * as ${RUNTIME_NAMESPACE} from "${PACKAGE_NAME}/internal/core";\n`;
const CAPNWEB_RUNTIME_IMPORT = `import * as ${RUNTIME_NAMESPACE} from "${PACKAGE_NAME}/internal/capnweb";\n`;

const MARKERS: Record<
  string,
  {
    side: "server" | "client";
    helper: string;
    targetArgIndex: number;
    form: "call" | "new";
  }
> = {
  newWorkersRpcResponse: {
    side: "server",
    form: "call",
    helper: "__newWorkersRpcResponseWithValidation",
    targetArgIndex: 1,
  },
  newWorkersWebSocketRpcResponse: {
    side: "server",
    form: "call",
    helper: "__newWorkersWebSocketRpcResponseWithValidation",
    targetArgIndex: 1,
  },
  newHttpBatchRpcResponse: {
    side: "server",
    form: "call",
    helper: "__newHttpBatchRpcResponseWithValidation",
    targetArgIndex: 1,
  },
  nodeHttpBatchRpcResponse: {
    side: "server",
    form: "call",
    helper: "__nodeHttpBatchRpcResponseWithValidation",
    targetArgIndex: 2,
  },
  newHttpBatchRpcSession: {
    side: "client",
    form: "call",
    helper: "__newHttpBatchRpcSessionWithValidation",
    targetArgIndex: -1,
  },
  newWebSocketRpcSession: {
    side: "client",
    form: "call",
    helper: "__newWebSocketRpcSessionWithValidation",
    targetArgIndex: -1,
  },
  newMessagePortRpcSession: {
    side: "client",
    form: "call",
    helper: "__newMessagePortRpcSessionWithValidation",
    targetArgIndex: -1,
  },
  RpcSession: {
    side: "client",
    form: "new",
    helper: "__newRpcSessionWithValidation",
    targetArgIndex: -1,
  },
};

const CAPNWEB_CLIENT_MARKERS = new Set([
  "newHttpBatchRpcSession",
  "newWebSocketRpcSession",
  "newMessagePortRpcSession",
  "RpcSession",
]);

export function transformModule(
  context: TransformContext,
  id: string,
  code: string
): TransformResult | null {
  if (!code.includes(PACKAGE_NAME) && !code.includes(CAPNWEB_PACKAGE_NAME)) {
    return null;
  }

  let sourceFile = context.getSourceFile(id);
  if (!sourceFile) return null;
  let checker = context.getChecker();

  let markerBindings = collectMarkerBindings(sourceFile);
  let decoratorBindings = collectDecoratorBindings(sourceFile);

  let callSites = [
    ...collectMarkerCallSites(sourceFile, markerBindings, checker),
    ...collectCapnwebClientCallSites(sourceFile, checker),
  ];
  let decoratorSites = collectDecoratorSites(
    sourceFile,
    decoratorBindings,
    checker
  );

  if (callSites.length === 0 && decoratorSites.length === 0) return null;

  let dedup = new ValidatorDedup();
  for (let site of callSites) {
    site.bindingName = dedup.bind(site.shape, site.side);
  }
  for (let site of decoratorSites) {
    site.bindingName = dedup.bind(site.shape, "server");
  }

  let edits: TextEdit[] = [];
  let needsCapnwebRuntime = callSites.length > 0;
  let prelude = needsCapnwebRuntime
    ? CAPNWEB_RUNTIME_IMPORT
    : CORE_RUNTIME_IMPORT;
  for (let entry of dedup.emitOrder()) {
    prelude += emitValidator(entry.bindingName, entry.shape) + "\n";
  }
  edits.push({ start: 0, end: 0, text: prelude });

  for (let cs of callSites) {
    let callee = cs.call.expression;
    let headStart =
      cs.marker.form === "new"
        ? cs.call.getStart(sourceFile)
        : callee.getStart(sourceFile);
    edits.push({
      start: headStart,
      end: callee.getEnd(),
      text: `${RUNTIME_NAMESPACE}.${cs.marker.helper}`,
    });
    let closeParenPos = cs.call.getEnd() - 1;
    let hasArgs = (cs.call.arguments?.length ?? 0) > 0;
    let insertion = hasArgs ? `, ${cs.bindingName!}` : `${cs.bindingName!}`;
    edits.push({ start: closeParenPos, end: closeParenPos, text: insertion });
  }

  for (let site of decoratorSites) {
    edits.push({
      start: site.decorator.expression.getStart(sourceFile),
      end: site.decorator.expression.getEnd(),
      text: `${RUNTIME_NAMESPACE}.__validateRpcClass(${site.bindingName!})`,
    });
  }

  return { code: applyTextEdits(code, edits) };
}

type MarkerBinding = {
  localName: string;
  markerName: keyof typeof MARKERS;
};

function collectMarkerBindings(sf: ts.SourceFile): Map<string, MarkerBinding> {
  let result = new Map<string, MarkerBinding>();
  for (let stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    let mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    if (mod.text !== CAPNWEB_MARKER_PACKAGE_NAME && mod.text !== PACKAGE_NAME)
      continue;
    let clause = stmt.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings))
      continue;
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

function collectDecoratorBindings(sf: ts.SourceFile): Set<string> {
  let result = new Set<string>();
  for (let stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    let mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    if (mod.text !== PACKAGE_NAME && mod.text !== CAPNWEB_MARKER_PACKAGE_NAME)
      continue;
    let clause = stmt.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings))
      continue;
    for (let spec of clause.namedBindings.elements) {
      let imported = (spec.propertyName ?? spec.name).text;
      if (imported === "validateRpc") result.add(spec.name.text);
    }
  }
  return result;
}

type CallSite = {
  call: ts.CallExpression | ts.NewExpression;
  marker: (typeof MARKERS)[keyof typeof MARKERS];
  side: "server" | "client";
  shape: ServiceShape;
  bindingName?: string;
};

type DecoratorSite = {
  decorator: ts.Decorator;
  cls: ts.ClassDeclaration;
  shape: ServiceShape;
  bindingName?: string;
};

function collectMarkerCallSites(
  sf: ts.SourceFile,
  bindings: Map<string, MarkerBinding>,
  checker: ts.TypeChecker
): CallSite[] {
  let out: CallSite[] = [];
  function visit(node: ts.Node): void {
    let isCall = ts.isCallExpression(node) && ts.isIdentifier(node.expression);
    let isNew =
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.arguments !== undefined;
    if (isCall || isNew) {
      let call = node as ts.CallExpression | ts.NewExpression;
      let binding = bindings.get((call.expression as ts.Identifier).text);
      if (binding)
        pushCallSite(
          out,
          sf,
          call,
          MARKERS[binding.markerName],
          binding.localName,
          checker
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

function collectCapnwebClientCallSites(
  sf: ts.SourceFile,
  checker: ts.TypeChecker
): CallSite[] {
  let out: CallSite[] = [];
  function visit(node: ts.Node): void {
    let isCall = ts.isCallExpression(node) && ts.isIdentifier(node.expression);
    let isNew =
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.arguments !== undefined;
    if (isCall || isNew) {
      let call = node as ts.CallExpression | ts.NewExpression;
      let name = (call.expression as ts.Identifier).text;
      if (
        CAPNWEB_CLIENT_MARKERS.has(name) &&
        isCapnwebSymbolAt(checker, call.expression)
      ) {
        let marker = MARKERS[name]!;
        let actual: "call" | "new" = isNew ? "new" : "call";
        if (marker.form === actual)
          pushCallSite(out, sf, call, marker, name, checker);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

function pushCallSite(
  out: CallSite[],
  sf: ts.SourceFile,
  call: ts.CallExpression | ts.NewExpression,
  marker: (typeof MARKERS)[keyof typeof MARKERS],
  localName: string,
  checker: ts.TypeChecker
): void {
  let expected = marker.form;
  let actual: "call" | "new" = ts.isNewExpression(call) ? "new" : "call";
  if (expected !== actual) return;
  let shape = resolveCallSiteShape(call, marker, checker);
  if (shape === null) {
    throw buildError(
      sf,
      call,
      `capnweb-validate: could not resolve a concrete service type for ` +
        `\`${localName}(...)\`. Annotate the call with a specific RPC service type.`
    );
  }
  rejectUnsupported(sf, call, localName, shape);
  out.push({ call, marker, side: marker.side, shape });
}

function collectDecoratorSites(
  sf: ts.SourceFile,
  decoratorBindings: Set<string>,
  checker: ts.TypeChecker
): DecoratorSite[] {
  let out: DecoratorSite[] = [];
  if (decoratorBindings.size === 0) return out;

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node)) {
      for (let decorator of ts.getDecorators(node) ?? []) {
        if (!isValidateRpcDecorator(decorator, decoratorBindings)) continue;
        let shape = resolveDecoratorShape(sf, node, decorator, checker);
        rejectUnsupported(sf, decorator, "validateRpc", shape);
        out.push({ decorator, cls: node, shape });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

function isValidateRpcDecorator(
  decorator: ts.Decorator,
  bindings: Set<string>
): boolean {
  let expression = decorator.expression;
  if (ts.isCallExpression(expression)) expression = expression.expression;
  return ts.isIdentifier(expression) && bindings.has(expression.text);
}

function resolveDecoratorShape(
  sf: ts.SourceFile,
  cls: ts.ClassDeclaration,
  decorator: ts.Decorator,
  checker: ts.TypeChecker
): ServiceShape {
  let classType = getClassInstanceType(cls, checker);
  let type =
    getDecoratorTypeArgument(decorator, checker) ??
    getSingleImplementedType(sf, cls, decorator, checker) ??
    classType;
  if (isTooGeneric(type)) {
    throw buildError(
      sf,
      decorator,
      `capnweb-validate: could not resolve a concrete service type for @validateRpc.`
    );
  }
  let resolved = resolveServiceShape(ts, checker, type);
  if (resolved === null) {
    throw buildError(
      sf,
      decorator,
      `capnweb-validate: could not resolve a concrete service type for @validateRpc.`
    );
  }
  let shape = cloneServiceShape(resolved);
  let skipped = collectClassSkipRpcValidationMethods(cls, checker);
  if (skipped.size > 0) shape = applySkippedMethods(shape, skipped);
  if (isWorkerEntrypointType(checker, classType)) {
    shape.targetKind = "workerEntrypoint";
  }
  return shape;
}

function getDecoratorTypeArgument(
  decorator: ts.Decorator,
  checker: ts.TypeChecker
): ts.Type | null {
  let expression = decorator.expression;
  if (!ts.isCallExpression(expression)) return null;
  let arg = expression.typeArguments?.[0];
  return arg ? checker.getTypeFromTypeNode(arg) : null;
}

function getSingleImplementedType(
  sf: ts.SourceFile,
  cls: ts.ClassDeclaration,
  decorator: ts.Decorator,
  checker: ts.TypeChecker
): ts.Type | null {
  let impls: ts.ExpressionWithTypeArguments[] = [];
  for (let clause of cls.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ImplementsKeyword)
      impls.push(...clause.types);
  }
  if (impls.length === 1) return checker.getTypeAtLocation(impls[0]!);
  if (impls.length > 1) {
    let { line, character } = sf.getLineAndCharacterOfPosition(
      decorator.getStart(sf)
    );
    console.warn(
      `${sf.fileName}:${line + 1}:${character + 1}: capnweb-validate: ` +
        `class implements multiple interfaces. Specify @validateRpc<Interface>() ` +
        `to restrict the RPC surface.`
    );
  }
  return null;
}

function getClassInstanceType(
  cls: ts.ClassDeclaration,
  checker: ts.TypeChecker
): ts.Type {
  let name = cls.name;
  if (name) {
    let sym = checker.getSymbolAtLocation(name);
    if (sym) return checker.getDeclaredTypeOfSymbol(sym);
  }
  return checker.getTypeAtLocation(cls);
}

function cloneServiceShape(shape: ServiceShape): ServiceShape {
  return {
    ...shape,
    methods: shape.methods.map((method) =>
      method.skipValidation
        ? { ...method }
        : {
            ...method,
            params: method.params.slice(),
          }
    ),
  };
}

function applySkippedMethods(
  shape: ServiceShape,
  skipped: Set<string>
): ServiceShape {
  return {
    ...shape,
    methods: shape.methods.map((method) =>
      skipped.has(method.name)
        ? { name: method.name, skipValidation: true }
        : method
    ),
  };
}

function collectClassSkipRpcValidationMethods(
  cls: ts.ClassDeclaration,
  checker: ts.TypeChecker
): Set<string> {
  let skipped = new Set<string>();
  for (let member of cls.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    let name = methodName(member.name);
    if (!name) continue;
    for (let decorator of ts.getDecorators(member) ?? []) {
      let expression = decorator.expression;
      if (ts.isCallExpression(expression)) expression = expression.expression;
      if (!ts.isIdentifier(expression)) continue;
      let sym = checker.getSymbolAtLocation(expression);
      if (sym && sym.flags & ts.SymbolFlags.Alias) {
        sym = checker.getAliasedSymbol(sym);
      }
      if (
        sym?.getName() === "skipRpcValidation" &&
        isValidatePackageSymbol(sym)
      ) {
        skipped.add(name);
      }
    }
  }
  return skipped;
}

function methodName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function isValidatePackageSymbol(sym: ts.Symbol): boolean {
  for (let decl of sym.getDeclarations() ?? []) {
    let fileName = decl.getSourceFile().fileName;
    if (/[\\/]capnweb-validate[\\/]/.test(fileName)) return true;
  }
  let parent = (sym as ts.Symbol & { parent?: ts.Symbol }).parent;
  if (!parent) return false;
  let name = parent.escapedName as string;
  return (
    name === '"capnweb-validate"' || name === '"capnweb-validate/capnweb"'
  );
}

function rejectUnsupported(
  sf: ts.SourceFile,
  node: ts.Node,
  label: string,
  shape: ServiceShape
): void {
  let bad = collectUnsupported(shape);
  if (bad.length === 0) return;
  let detail = bad.map((b) => `  - ${b.path}: ${b.reason}`).join("\n");
  throw buildError(
    sf,
    node,
    `capnweb-validate: \`${label}\` references types that capnweb cannot ` +
      `transport. Fix or replace these fields:\n${detail}`
  );
}

function resolveCallSiteShape(
  call: ts.CallExpression | ts.NewExpression,
  marker: (typeof MARKERS)[keyof typeof MARKERS],
  checker: ts.TypeChecker
): ServiceShape | null {
  let type: ts.Type;
  if (marker.side === "server") {
    let arg = call.arguments?.[marker.targetArgIndex];
    if (!arg) return null;
    type = checker.getTypeAtLocation(arg);
  } else if (marker.form === "new") {
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
  if (isTooGeneric(type)) return null;
  return resolveServiceShape(ts, checker, type);
}

function getExplicitTypeArgument(
  call: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker
): ts.Type | null {
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
  if (flags & ts.TypeFlags.TypeParameter) return true;
  if (flags & ts.TypeFlags.Any) return true;
  if (flags & ts.TypeFlags.Unknown) return true;
  if (flags & ts.TypeFlags.Never) return true;
  let name = type.getSymbol()?.getName();
  if (name === "RpcTarget" || name === "WorkerEntrypoint") return true;
  return false;
}

function isCapnwebSymbolAt(checker: ts.TypeChecker, node: ts.Node): boolean {
  let sym = checker.getSymbolAtLocation(node);
  if (sym && sym.flags & ts.SymbolFlags.Alias)
    sym = checker.getAliasedSymbol(sym);
  if (!sym) return false;
  for (let decl of sym.getDeclarations() ?? []) {
    let fileName = decl.getSourceFile().fileName;
    if (/[\\/]capnweb[\\/]/.test(fileName)) return true;
  }
  let parent = (sym as ts.Symbol & { parent?: ts.Symbol }).parent;
  return !!parent && (parent.escapedName as string) === '"capnweb"';
}

class ValidatorDedup {
  #emitted = new Map<
    string,
    { bindingName: string; shape: ServiceShape; signature: string }[]
  >();
  #order: { bindingName: string; shape: ServiceShape }[] = [];

  bind(shape: ServiceShape, side: "server" | "client"): string {
    let key = `${side}:${shape.name}`;
    let entries = this.#emitted.get(key) ?? [];
    let signature = serviceSignature(shape);
    let existing = entries.find((entry) => entry.signature === signature);
    if (existing) return existing.bindingName;
    let suffix = entries.length === 0 ? "" : `_${entries.length + 1}`;
    let bindingName = `__capnweb_validate_${sanitize(
      shape.name
    )}_${side}${suffix}`;
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
  return JSON.stringify({
    targetKind: shape.targetKind ?? null,
    methods: shape.methods.map((method) =>
      method.skipValidation
        ? {
            name: method.name,
            unchecked: true,
          }
        : {
            name: method.name,
            params: method.params.map((param) => typeSignature(param)),
            rest: method.rest ? typeSignature(method.rest) : null,
            returns: typeSignature(method.returns),
          }
    ),
  });
}

function typeSignature(shape: TypeShape): unknown {
  switch (shape.kind) {
    case "literal":
      return [shape.kind, shape.value];
    case "array":
      return [shape.kind, typeSignature(shape.element)];
    case "tuple":
      return [
        shape.kind,
        shape.elements.map((element) => typeSignature(element)),
      ];
    case "object":
      return [
        shape.kind,
        shape.name,
        sortedEntries(shape.properties),
        shape.index ? typeSignature(shape.index) : null,
      ];
    case "union":
      return [
        shape.kind,
        shape.branches.map((branch) => typeSignature(branch)),
      ];
    case "ref":
      return [shape.kind, shape.id];
    case "stub":
      return [
        shape.kind,
        shape.service ? serviceSignature(shape.service) : null,
      ];
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

function buildError(sf: ts.SourceFile, node: ts.Node, message: string): Error {
  let { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return new Error(`${sf.fileName}:${line + 1}:${character + 1}: ${message}`);
}
