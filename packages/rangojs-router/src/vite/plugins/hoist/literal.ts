/**
 * Literal-level helpers shared by the build-time predicate hoists
 * (transition-when-hoist.ts moves a `when` from a server module into a
 * "use client" one; client-urls-revalidate-hoist.ts moves a `revalidate()`
 * from a "use client" module into a server one): finding a urls-callback
 * helper's calls, the lexical-capture check, and the free imports a literal
 * re-emits in its new module.
 */

import {
  TYPE_KEYS,
  type ImportBinding,
  type Node,
  type Reference,
  type Scope,
} from "./scope.js";

export function hasDirective(program: Node, directive: string): boolean {
  for (const statement of program.body) {
    if (
      statement.type !== "ExpressionStatement" ||
      typeof statement.directive !== "string"
    ) {
      return false;
    }
    if (statement.directive === directive) return true;
  }
  return false;
}

/** The offset after the directive prologue (0 when there is none). */
export function directivePrologueEnd(program: Node): number {
  let end = 0;
  for (const statement of program.body) {
    if (
      statement.type !== "ExpressionStatement" ||
      typeof statement.directive !== "string"
    ) {
      break;
    }
    end = statement.end;
  }
  return end;
}

export function lineColumn(code: string, offset: number): string {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return `${line}:${column}`;
}

export function parseLang(file: string): "ts" | "tsx" | "jsx" {
  // A .ts file parses as ts: tsx would reject `<T>expr` and `<T>(x) => x`.
  if (/\.[cm]?ts$/.test(file)) return "ts";
  if (/\.[cm]?jsx?$/.test(file)) return "jsx";
  return "tsx";
}

const EXPRESSION_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);

export function unwrapExpression(node: Node): Node {
  while (node && EXPRESSION_WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

export function isFunctionLiteral(node: Node): boolean {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression"
  );
}

export function propertyKeyIs(prop: Node, name: string): boolean {
  return (
    prop?.type === "Property" &&
    !prop.computed &&
    ((prop.key.type === "Identifier" && prop.key.name === name) ||
      (prop.key.type === "Literal" && prop.key.value === name))
  );
}

/** Which helper calls {@link findHelperCalls} looks for. */
export interface HelperCallSpec {
  /** Module specifiers the builder (and a direct helper import) come from. */
  readonly sources: ReadonlySet<string>;
  /** The builder export whose callback's first parameter hands out `helper`. */
  readonly builder: string;
  readonly helper: string;
  /** A direct import of `helper` from `sources` counts too. */
  readonly directImport: boolean;
}

export interface HelperCall {
  readonly call: Node;
  readonly scope: Scope;
}

/** What a builder callback's first parameter binds the helper to. */
interface HelperBindings {
  /** `({ helper })`, `({ helper: h })`. */
  readonly names: Set<string>;
  /** `(helpers) => helpers.helper(...)`. */
  readonly objects: Set<string>;
}

/**
 * Every call of `spec.helper` the builder's callback hands out: destructured,
 * renamed or as `helpers.<helper>`, at any depth of the callback, plus a
 * direct import when `spec.directImport`. A builder is recognised by its
 * import (named, renamed, or through a namespace); any other function of the
 * same name is left alone.
 */
export function findHelperCalls(
  program: Node,
  scopeOf: Map<Node, Scope>,
  moduleScope: Scope,
  imports: Map<string, ImportBinding>,
  spec: HelperCallSpec,
): HelperCall[] {
  const calls: HelperCall[] = [];
  const helpers = new Map<Scope, HelperBindings>();

  // The export a callee names: `urls`, `transition as t`, `Rango.urls`.
  const sourceExport = (callee: Node, scope: Scope): string | null => {
    const sourceImport = (id: Node): ImportBinding | null => {
      if (id?.type !== "Identifier") return null;
      if (scope.lookup(id.name) !== moduleScope) return null;
      const binding = imports.get(id.name);
      return binding && spec.sources.has(binding.source) && !binding.typeOnly
        ? binding
        : null;
    };
    if (callee.type === "Identifier") {
      const imported = sourceImport(callee)?.imported;
      return imported && imported !== "*" && imported !== "default"
        ? imported
        : null;
    }
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      sourceImport(callee.object)?.imported === "*"
    ) {
      return callee.property.name;
    }
    return null;
  };

  const registerBuilderCallback = (callback: Node): void => {
    const fnScope = scopeOf.get(callback);
    let param = callback.params[0];
    if (param?.type === "AssignmentPattern") param = param.left;
    if (!fnScope || !param) return;
    const bindings: HelperBindings = { names: new Set(), objects: new Set() };
    if (param.type === "Identifier") bindings.objects.add(param.name);
    if (param.type === "ObjectPattern") {
      for (const prop of param.properties) {
        if (!propertyKeyIs(prop, spec.helper)) continue;
        const target =
          prop.value.type === "AssignmentPattern"
            ? prop.value.left
            : prop.value;
        if (target.type === "Identifier") bindings.names.add(target.name);
      }
    }
    helpers.set(fnScope, bindings);
  };

  const isHelper = (callee: Node, scope: Scope): boolean => {
    if (spec.directImport && sourceExport(callee, scope) === spec.helper) {
      return true;
    }
    if (callee.type === "Identifier") {
      const decl = scope.lookup(callee.name);
      return !!decl && !!helpers.get(decl)?.names.has(callee.name);
    }
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === spec.helper &&
      callee.object.type === "Identifier"
    ) {
      const decl = scope.lookup(callee.object.name);
      return !!decl && !!helpers.get(decl)?.objects.has(callee.object.name);
    }
    return false;
  };

  const visit = (node: Node, scope: Scope): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, scope);
      return;
    }
    if (typeof node.type !== "string") return;
    const own = scopeOf.get(node) ?? scope;
    if (node.type === "CallExpression") {
      // Registered before the callback body is visited, which is where its
      // helper calls are.
      const callback = node.arguments[0];
      if (
        isFunctionLiteral(callback) &&
        sourceExport(node.callee, own) === spec.builder
      ) {
        registerBuilderCallback(callback);
      }
      if (isHelper(node.callee, own)) calls.push({ call: node, scope: own });
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      visit(node[key], own);
    }
  };
  visit(program.body, moduleScope);
  return calls;
}

/**
 * What a lexical-capture error says, per hoist direction. `lexical` explains
 * each construct (`this`, `arguments`, `super`, `new.target`); `captureHint`
 * and `loadsHint` follow every capture and module-load message;
 * `importMetaWhy`, `importMetaMemberWhy` and `dynamicImportWhy` explain the
 * module-loading expressions.
 */
export interface LexicalCaptureMessages {
  readonly lexical: Readonly<Record<string, string>>;
  readonly captureHint: string;
  readonly loadsHint: string;
  readonly importMetaWhy: string;
  readonly importMetaMemberWhy: string;
  readonly dynamicImportWhy: string;
}

/**
 * The first use in a literal of a lexical context it would lose when hoisted
 * (`this`, `arguments`, `super`, `new.target` of an enclosing function or
 * object), or of a module-loading expression the build cannot check
 * (`import()`, `import.meta` other than `import.meta.env`). A nested
 * non-arrow function (or class body) owns its `this`/`arguments`, so uses
 * inside one are fine; a method literal owns them too, but its `super`
 * loses the object it was defined on.
 */
export function findLexicalCapture(
  literal: Node,
  references: readonly Reference[],
  code: string,
  messages: LexicalCaptureMessages,
): { node: Node; detail: string } | null {
  const ownArguments: Node[] = [];
  let found: { node: Node; detail: string } | null = null;
  const capture = (node: Node, what: string): void => {
    found = {
      node,
      detail: `${messages.lexical[what]} ${messages.captureHint}`,
    };
  };
  const loads = (node: Node, expression: string, why: string): void => {
    found = {
      node,
      detail: `\`${expression}\` ${why} ${messages.loadsHint}`,
    };
  };

  const visit = (node: Node, boundary: Node | null): void => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, boundary);
      return;
    }
    if (typeof node.type !== "string") return;
    switch (node.type) {
      case "FunctionExpression":
      case "FunctionDeclaration":
        ownArguments.push(node);
        boundary = node;
        break;
      case "ClassBody":
        boundary = node;
        break;
      case "ThisExpression":
        if (!boundary) capture(node, "this");
        return;
      case "Super":
        if (!boundary || boundary === literal) capture(node, "super");
        return;
      case "JSXMemberExpression": {
        let root = node;
        while (root.type === "JSXMemberExpression") root = root.object;
        if (root.name === "this" && !boundary) capture(root, "this");
        return;
      }
      case "MetaProperty":
        if (node.meta.name === "import") {
          loads(node, "import.meta", messages.importMetaWhy);
        } else if (!boundary) {
          capture(node, "new.target");
        }
        return;
      case "MemberExpression":
        if (node.object?.type === "MetaProperty") {
          if (node.object.meta.name !== "import") break;
          if (!node.computed && node.property.name === "env") return;
          loads(
            node,
            node.computed
              ? "import.meta[...]"
              : `import.meta.${node.property.name}`,
            messages.importMetaMemberWhy,
          );
          return;
        }
        break;
      case "ImportExpression":
        loads(
          node,
          `import(${code.slice(node.source.start, node.source.end)})`,
          messages.dynamicImportWhy,
        );
        return;
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (TYPE_KEYS.has(key)) continue;
      visit(node[key], boundary);
    }
  };
  visit(literal, null);
  if (found) return found;

  for (const ref of references) {
    if (ref.typeOnly || ref.node.name !== "arguments") continue;
    if (ref.node.start < literal.start || ref.node.end > literal.end) continue;
    const owned = ownArguments.some(
      (fn) => fn.start <= ref.node.start && ref.node.end <= fn.end,
    );
    if (!owned) {
      capture(ref.node, "arguments");
      return found;
    }
  }
  return null;
}

/** The free references of a literal, by what they resolve to. */
export interface FreeReferences {
  /** Import local name -> whether any use is a value use. */
  readonly imports: Map<string, boolean>;
  /** Value references to a binding declared outside the literal that is not an import. */
  readonly bindings: readonly Reference[];
  /** References declared nowhere (window, URL, console, ...). */
  readonly globals: readonly Reference[];
}

/** Every reference inside `literal` to something declared outside it. */
export function collectFreeReferences(
  literal: Node,
  references: readonly Reference[],
  moduleScope: Scope,
  imports: Map<string, ImportBinding>,
): FreeReferences {
  const used = new Map<string, boolean>();
  const bindings: Reference[] = [];
  const globals: Reference[] = [];
  for (const ref of references) {
    if (ref.node.start < literal.start || ref.node.end > literal.end) continue;
    const decl = ref.scope.lookup(ref.node.name);
    if (!decl) {
      if (!ref.typeOnly) globals.push(ref);
      continue;
    }
    if (
      decl.node.start >= literal.start &&
      decl.node.end <= literal.end &&
      decl !== moduleScope
    ) {
      continue; // declared inside the literal
    }
    if (decl === moduleScope && imports.has(ref.node.name)) {
      const valueUse = !ref.typeOnly && !imports.get(ref.node.name)!.typeOnly;
      used.set(ref.node.name, (used.get(ref.node.name) ?? false) || valueUse);
      continue;
    }
    if (ref.typeOnly) continue; // a local type: erased
    bindings.push(ref);
  }
  return { imports: used, bindings, globals };
}

/**
 * Re-emit the imports a literal uses, grouped per source, type-only uses as
 * `import type`. `checkValueImport` runs first for each value use and throws
 * to reject one.
 */
export async function emitImports(
  used: Map<string, boolean>,
  imports: Map<string, ImportBinding>,
  checkValueImport: (
    local: string,
    binding: ImportBinding,
  ) => Promise<void> | void,
): Promise<string[]> {
  const bySource = new Map<string, string[]>();
  for (const [local, valueUse] of used) {
    const binding = imports.get(local)!;
    if (valueUse) await checkValueImport(local, binding);
    const lines = bySource.get(binding.source) ?? [];
    const typePrefix = valueUse ? "" : "type ";
    if (binding.imported === "*") {
      lines.push(
        `import ${typePrefix}* as ${local} from ${JSON.stringify(binding.source)};`,
      );
    } else if (binding.imported === "default") {
      lines.push(
        `import ${typePrefix}${local} from ${JSON.stringify(binding.source)};`,
      );
    } else {
      const spec =
        binding.imported === local
          ? local
          : `${JSON.stringify(binding.imported)} as ${local}`;
      lines.push(
        `import ${typePrefix}{ ${spec} } from ${JSON.stringify(binding.source)};`,
      );
    }
    bySource.set(binding.source, lines);
  }
  return [...bySource.values()].flat();
}
