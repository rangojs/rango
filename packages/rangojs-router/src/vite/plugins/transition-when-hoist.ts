import type { Plugin } from "vite";
import { normalizePath, parseAst } from "vite";
import MagicString from "magic-string";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { TransitionWhenError } from "../../transition-when-ref.js";

/**
 * Inline transition({ when }) in urls(): the build hoists the function
 * literal into a virtual "use client" module, so it reaches the browser as a
 * client reference like an exported predicate would.
 *
 *   transition({ when: (ctx) => ctx.to.params.tab !== "raw" })
 *
 * becomes, in the urls module,
 *
 *   import { __rango_when as __rango_when_0 } from "<file>?rango-when=0";
 *   transition({ when: __rango_when_0 })
 *
 * and `<file>?rango-when=0` (a query on the urls file itself, so relative
 * imports resolve as they did there and an edit invalidates it in every
 * environment's graph) is
 *
 *   "use client";
 *   <the module-level imports the literal references>
 *   export const __rango_when = (ctx) => ctx.to.params.tab !== "raw";
 *
 * Keyed on `transition({ when: <function literal> })` where the callee is the
 * router's transition: an import from "@rangojs/router" (renamed or through a
 * namespace), or the helper a router urls() callback receives (destructured,
 * renamed, or as `helpers.transition`). Any other function named
 * `transition` is left alone. There is no function-level "use client" (React
 * defines the directive per module). The literal may be an arrow, a function
 * expression or a `when() {}` method, under TS wrappers (`as`, `satisfies`,
 * `!`, `<T>`), which are dropped.
 *
 * A literal may not capture anything: a free reference to a module binding
 * that is not an import (JSX component names included), to an enclosing
 * function's binding, or an arrow's lexical `this`/`arguments`/`super`/
 * `new.target`, is a LOUD error naming it; so are `import()` and
 * `import.meta` other than `import.meta.env`, whose targets the build cannot
 * check. Referenced imports are re-emitted, so they must be client-safe: a
 * server-only one fails naming the import. An identifier value must be a
 * "use client" import; a local binding fails here, anything else in route
 * discovery. "use client" modules (clientUrls()) are left alone: their `when`
 * is already browser code. Vitest does not run the plugin, so in unit tests
 * the literal stays a plain function.
 */

const TRANSITION_WHEN_QUERY = "rango-when";
const EXPORT_NAME = "__rango_when";
const LOCAL_PREFIX = "__rango_when_";

type Node = any;

interface ImportBinding {
  readonly source: string;
  /** "default", "*", or the imported name. */
  readonly imported: string;
  readonly typeOnly: boolean;
}

class Scope {
  readonly declarations = new Set<string>();
  constructor(
    readonly parent: Scope | null,
    readonly isFunction: boolean,
    readonly node: Node,
  ) {}
  nearestFunction(): Scope {
    return this.isFunction || !this.parent
      ? this
      : this.parent.nearestFunction();
  }
  lookup(name: string): Scope | null {
    if (this.declarations.has(name)) return this;
    return this.parent ? this.parent.lookup(name) : null;
  }
}

interface Reference {
  readonly node: Node;
  readonly scope: Scope;
  readonly typeOnly: boolean;
}

const TYPE_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
  "implements",
]);

/**
 * The identifier a JSX element name refers to: a component (`<Local />`) or
 * the root of a member name (`<ui.Badge />`). Lowercase and dashed names are
 * intrinsic tags, not references; `<this.X />` is checked as `this`.
 */
function jsxNameReference(name: Node): Node | null {
  if (name?.type === "JSXIdentifier") {
    return /^[a-z]/.test(name.name) || name.name.includes("-") ? null : name;
  }
  let root = name;
  while (root?.type === "JSXMemberExpression") root = root.object;
  return root?.type === "JSXIdentifier" && root.name !== "this" ? root : null;
}

function patternNames(pattern: Node, names: string[] = []): string[] {
  if (!pattern) return names;
  switch (pattern.type) {
    case "Identifier":
      names.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        patternNames(prop.type === "RestElement" ? prop : prop.value, names);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) patternNames(element, names);
      break;
    case "RestElement":
      patternNames(pattern.argument, names);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, names);
      break;
    case "TSParameterProperty":
      patternNames(pattern.parameter, names);
      break;
  }
  return names;
}

/**
 * Scope tree and every identifier reference of a module, TS type positions
 * flagged. Enough of ES scoping for free-variable analysis of one literal:
 * var hoists to the function scope, let/const/class to the block, function
 * declarations to their block.
 */
function analyzeScopes(program: Node): {
  moduleScope: Scope;
  references: Reference[];
  scopeOf: Map<Node, Scope>;
} {
  const moduleScope = new Scope(null, true, program);
  const scopeOf = new Map<Node, Scope>([[program, moduleScope]]);
  const references: Reference[] = [];

  const declarePattern = (pattern: Node, scope: Scope): void => {
    for (const name of patternNames(pattern)) scope.declarations.add(name);
  };

  // Binding patterns: identifiers declare; defaults and computed keys refer.
  const walkPattern = (pattern: Node, scope: Scope, typeOnly: boolean) => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        if (pattern.typeAnnotation) walk(pattern.typeAnnotation, scope, true);
        return;
      case "ObjectPattern":
        for (const prop of pattern.properties) {
          if (prop.type === "RestElement") {
            walkPattern(prop.argument, scope, typeOnly);
          } else {
            if (prop.computed) walk(prop.key, scope, typeOnly);
            walkPattern(prop.value, scope, typeOnly);
          }
        }
        if (pattern.typeAnnotation) walk(pattern.typeAnnotation, scope, true);
        return;
      case "ArrayPattern":
        for (const element of pattern.elements) {
          walkPattern(element, scope, typeOnly);
        }
        if (pattern.typeAnnotation) walk(pattern.typeAnnotation, scope, true);
        return;
      case "RestElement":
        walkPattern(pattern.argument, scope, typeOnly);
        return;
      case "AssignmentPattern":
        walkPattern(pattern.left, scope, typeOnly);
        walk(pattern.right, scope, typeOnly);
        return;
      case "TSParameterProperty":
        walkPattern(pattern.parameter, scope, typeOnly);
        return;
      default:
        walk(pattern, scope, typeOnly);
    }
  };

  // Hoist function-scoped and block-scoped declarations of a body before its
  // statements are walked, so a reference ahead of its declaration resolves.
  const hoistDeclarations = (statements: Node[], scope: Scope): void => {
    for (const statement of statements) {
      const node =
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration"
          ? statement.declaration
          : statement;
      if (!node) continue;
      switch (node.type) {
        case "ImportDeclaration":
          for (const spec of node.specifiers) {
            scope.declarations.add(spec.local.name);
          }
          break;
        case "FunctionDeclaration":
        case "ClassDeclaration":
        case "TSEnumDeclaration":
        case "TSTypeAliasDeclaration":
        case "TSInterfaceDeclaration":
        case "TSModuleDeclaration":
          if (node.id?.type === "Identifier") {
            scope.declarations.add(node.id.name);
          }
          break;
        case "VariableDeclaration":
          for (const declarator of node.declarations) {
            declarePattern(
              declarator.id,
              node.kind === "var" ? scope.nearestFunction() : scope,
            );
          }
          break;
      }
    }
  };

  const walk = (node: Node, scope: Scope, typeOnly: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, scope, typeOnly);
      return;
    }
    if (typeof node.type !== "string") return;

    switch (node.type) {
      case "Identifier":
        references.push({ node, scope, typeOnly });
        if (node.typeAnnotation) walk(node.typeAnnotation, scope, true);
        return;
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        return;
      case "ExportNamedDeclaration":
        if (node.declaration) walk(node.declaration, scope, typeOnly);
        else if (!node.source) {
          for (const spec of node.specifiers) {
            walk(spec.local, scope, typeOnly || node.exportKind === "type");
          }
        }
        return;
      case "MemberExpression":
        walk(node.object, scope, typeOnly);
        if (node.computed) walk(node.property, scope, typeOnly);
        return;
      case "Property":
      case "MethodDefinition":
      case "PropertyDefinition":
      case "TSPropertySignature":
      case "TSMethodSignature":
        if (node.computed) walk(node.key, scope, typeOnly);
        walk(node.value, scope, typeOnly);
        if (node.typeAnnotation) walk(node.typeAnnotation, scope, true);
        return;
      case "LabeledStatement":
        walk(node.body, scope, typeOnly);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
        return;
      case "JSXOpeningElement":
      case "JSXClosingElement": {
        const ref = jsxNameReference(node.name);
        if (ref) references.push({ node: ref, scope, typeOnly });
        walk(node.typeArguments, scope, true);
        walk(node.attributes, scope, typeOnly);
        return;
      }
      case "TSQualifiedName":
        walk(node.left, scope, typeOnly);
        return;
      case "TSEnumMember":
        walk(node.initializer, scope, typeOnly);
        return;
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
        walk(node.typeParameters, scope, true);
        walk(node.typeAnnotation ?? node.body, scope, true);
        walk(node.extends, scope, true);
        return;
      case "VariableDeclarator":
        walkPattern(node.id, scope, typeOnly);
        walk(node.init, scope, typeOnly);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const fnScope = new Scope(scope, true, node);
        scopeOf.set(node, fnScope);
        if (node.type === "FunctionExpression" && node.id) {
          fnScope.declarations.add(node.id.name);
        }
        for (const param of node.params) declarePattern(param, fnScope);
        walk(node.typeParameters, fnScope, true);
        for (const param of node.params) walkPattern(param, fnScope, typeOnly);
        walk(node.returnType, fnScope, true);
        if (node.body?.type === "BlockStatement") {
          hoistDeclarations(node.body.body, fnScope);
          walk(node.body.body, fnScope, typeOnly);
        } else {
          walk(node.body, fnScope, typeOnly);
        }
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        let classScope = scope;
        if (node.type === "ClassExpression" && node.id) {
          classScope = new Scope(scope, false, node);
          classScope.declarations.add(node.id.name);
          scopeOf.set(node, classScope);
        }
        walk(node.superClass, classScope, typeOnly);
        walk(node.superTypeArguments, classScope, true);
        walk(node.typeParameters, classScope, true);
        walk(node.implements, classScope, true);
        walk(node.body, classScope, typeOnly);
        return;
      }
      case "BlockStatement":
      case "StaticBlock": {
        const blockScope = new Scope(scope, false, node);
        scopeOf.set(node, blockScope);
        hoistDeclarations(node.body, blockScope);
        walk(node.body, blockScope, typeOnly);
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const loopScope = new Scope(scope, false, node);
        scopeOf.set(node, loopScope);
        const head = node.type === "ForStatement" ? node.init : node.left;
        if (head?.type === "VariableDeclaration") {
          hoistDeclarations([head], loopScope);
        }
        for (const key of ["init", "left", "right", "test", "update", "body"]) {
          walk(node[key], loopScope, typeOnly);
        }
        return;
      }
      case "SwitchStatement": {
        walk(node.discriminant, scope, typeOnly);
        const switchScope = new Scope(scope, false, node);
        scopeOf.set(node, switchScope);
        hoistDeclarations(
          node.cases.flatMap((c: Node) => c.consequent),
          switchScope,
        );
        for (const c of node.cases) {
          walk(c.test, switchScope, typeOnly);
          walk(c.consequent, switchScope, typeOnly);
        }
        return;
      }
      case "CatchClause": {
        const catchScope = new Scope(scope, false, node);
        scopeOf.set(node, catchScope);
        if (node.param) {
          declarePattern(node.param, catchScope);
          walkPattern(node.param, catchScope, typeOnly);
        }
        walk(node.body, catchScope, typeOnly);
        return;
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      walk(node[key], scope, typeOnly || TYPE_KEYS.has(key));
    }
  };

  hoistDeclarations(program.body, moduleScope);
  walk(program.body, moduleScope, false);
  return { moduleScope, references, scopeOf };
}

function collectImports(program: Node): Map<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const declTypeOnly = statement.importKind === "type";
    for (const spec of statement.specifiers) {
      imports.set(spec.local.name, {
        source: statement.source.value,
        imported:
          spec.type === "ImportDefaultSpecifier"
            ? "default"
            : spec.type === "ImportNamespaceSpecifier"
              ? "*"
              : spec.imported.type === "Identifier"
                ? spec.imported.name
                : String(spec.imported.value),
        typeOnly: declTypeOnly || spec.importKind === "type",
      });
    }
  }
  return imports;
}

function hasUseClientDirective(program: Node): boolean {
  for (const statement of program.body) {
    if (
      statement.type !== "ExpressionStatement" ||
      typeof statement.directive !== "string"
    ) {
      return false;
    }
    if (statement.directive === "use client") return true;
  }
  return false;
}

function lineColumn(code: string, offset: number): string {
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

/**
 * A `when` site: the `when` property of a router transition() config, and its
 * value with TS wrappers dropped (a function literal, an identifier, ...).
 */
interface WhenSite {
  readonly prop: Node;
  readonly value: Node;
  readonly scope: Scope;
}

const ROUTER_SOURCE = "@rangojs/router";

const EXPRESSION_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);

function unwrapExpression(node: Node): Node {
  while (node && EXPRESSION_WRAPPERS.has(node.type)) node = node.expression;
  return node;
}

function isFunctionLiteral(node: Node): boolean {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression"
  );
}

function propertyKeyIs(prop: Node, name: string): boolean {
  return (
    prop?.type === "Property" &&
    !prop.computed &&
    ((prop.key.type === "Identifier" && prop.key.name === name) ||
      (prop.key.type === "Literal" && prop.key.value === name))
  );
}

/** What a urls() callback's first parameter binds the transition helper to. */
interface HelperBindings {
  /** `({ transition })`, `({ transition: t })`. */
  readonly transitions: Set<string>;
  /** `(helpers) => helpers.transition(...)`. */
  readonly objects: Set<string>;
}

function findWhenSites(
  program: Node,
  scopeOf: Map<Node, Scope>,
  moduleScope: Scope,
  imports: Map<string, ImportBinding>,
): WhenSite[] {
  const sites: WhenSite[] = [];
  const helpers = new Map<Scope, HelperBindings>();

  // The router export a callee names: `urls`, `transition as t`, `Rango.urls`.
  const routerExport = (callee: Node, scope: Scope): string | null => {
    const routerImport = (id: Node): ImportBinding | null => {
      if (id?.type !== "Identifier") return null;
      if (scope.lookup(id.name) !== moduleScope) return null;
      const binding = imports.get(id.name);
      return binding?.source === ROUTER_SOURCE && !binding.typeOnly
        ? binding
        : null;
    };
    if (callee.type === "Identifier") {
      const imported = routerImport(callee)?.imported;
      return imported && imported !== "*" && imported !== "default"
        ? imported
        : null;
    }
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      routerImport(callee.object)?.imported === "*"
    ) {
      return callee.property.name;
    }
    return null;
  };

  const registerUrlsCallback = (callback: Node): void => {
    const fnScope = scopeOf.get(callback);
    let param = callback.params[0];
    if (param?.type === "AssignmentPattern") param = param.left;
    if (!fnScope || !param) return;
    const bindings: HelperBindings = {
      transitions: new Set(),
      objects: new Set(),
    };
    if (param.type === "Identifier") bindings.objects.add(param.name);
    if (param.type === "ObjectPattern") {
      for (const prop of param.properties) {
        if (!propertyKeyIs(prop, "transition")) continue;
        const target =
          prop.value.type === "AssignmentPattern"
            ? prop.value.left
            : prop.value;
        if (target.type === "Identifier") bindings.transitions.add(target.name);
      }
    }
    helpers.set(fnScope, bindings);
  };

  const isRouterTransition = (callee: Node, scope: Scope): boolean => {
    if (routerExport(callee, scope) === "transition") return true;
    if (callee.type === "Identifier") {
      const decl = scope.lookup(callee.name);
      return !!decl && !!helpers.get(decl)?.transitions.has(callee.name);
    }
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === "transition" &&
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
      // transition() calls are.
      const callback = node.arguments[0];
      if (
        isFunctionLiteral(callback) &&
        routerExport(node.callee, own) === "urls"
      ) {
        registerUrlsCallback(callback);
      }
      if (
        node.arguments[0]?.type === "ObjectExpression" &&
        isRouterTransition(node.callee, own)
      ) {
        for (const prop of node.arguments[0].properties) {
          if (propertyKeyIs(prop, "when")) {
            sites.push({
              prop,
              value: unwrapExpression(prop.value),
              scope: own,
            });
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      visit(node[key], own);
    }
  };
  visit(program.body, moduleScope);
  return sites;
}

/** Why a lexical-context use in a literal is a capture, by construct. */
const LEXICAL_CAPTURE: Record<string, string> = {
  this: "`this` in an arrow is the enclosing server function's `this`.",
  arguments:
    "`arguments` in an arrow is the enclosing server function's `arguments`.",
  super: "`super` refers to the enclosing server object.",
  "new.target": "`new.target` in an arrow is the enclosing server function's.",
};

/**
 * The first use in a literal of a lexical context it would lose when hoisted
 * (`this`, `arguments`, `super`, `new.target` of an enclosing server function
 * or object), or of a module-loading expression the build cannot check
 * (`import()`, `import.meta` other than `import.meta.env`). A nested
 * non-arrow function (or class body) owns its `this`/`arguments`, so uses
 * inside one are fine; a method literal owns them too, but its `super`
 * loses the object it was defined on.
 */
function findLexicalCapture(
  literal: Node,
  references: readonly Reference[],
  code: string,
): { node: Node; detail: string } | null {
  const ownArguments: Node[] = [];
  let found: { node: Node; detail: string } | null = null;
  const capture = (node: Node, what: string): void => {
    found = {
      node,
      detail:
        `${LEXICAL_CAPTURE[what]} Read what you need from ` +
        '`to.params`/`to.state`, or export the predicate from a "use client" ' +
        "module.",
    };
  };
  const loads = (node: Node, expression: string, why: string): void => {
    found = {
      node,
      detail:
        `\`${expression}\` ${why} Import client-safe modules statically, ` +
        'or export the predicate from a "use client" module.',
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
          loads(node, "import.meta", "is the server module's.");
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
            "is resolved against the server module; only `import.meta.env` " +
              "is available to an inline predicate.",
          );
          return;
        }
        break;
      case "ImportExpression":
        loads(
          node,
          `import(${code.slice(node.source.start, node.source.end)})`,
          "loads a module at run time, which the build cannot check is " +
            "client-safe.",
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

const NODE_BUILTINS = new Set(builtinModules);

/** Specifiers that can never load in the browser. */
export function isServerOnlySpecifier(source: string): boolean {
  return (
    source === "server-only" ||
    source.startsWith("node:") ||
    source.startsWith("cloudflare:") ||
    NODE_BUILTINS.has(source)
  );
}

export interface HoistTransitionWhenDeps {
  /**
   * Whether an import the literal re-emits is server-only beyond its
   * specifier (the plugin resolves it and looks for `import "server-only"`).
   */
  isServerOnlyImport?(source: string): Promise<boolean> | boolean;
}

export interface HoistTransitionWhenResult {
  readonly code: string;
  readonly map: ReturnType<MagicString["generateMap"]>;
  /** Virtual module source per hoisted literal, by index. */
  readonly modules: readonly string[];
}

// Cheap pre-filter before a parse: every hoistable site needs an import from
// the router (transition itself, or the urls() that hands it out) and a
// `when` key in some form (`when:`, `"when":`, `when() {}`, `get when()`),
// possibly under an alias, so no tighter pattern holds. The AST walk is the
// authority.
const ROUTER_IMPORT_RE = /["']@rangojs\/router["']/;
const WHEN_RE = /\bwhen\b/;

function parseLang(file: string): "ts" | "tsx" | "jsx" {
  // A .ts file parses as ts: tsx would reject `<T>expr` and `<T>(x) => x`.
  if (/\.[cm]?ts$/.test(file)) return "ts";
  if (/\.[cm]?jsx?$/.test(file)) return "jsx";
  return "tsx";
}

function whenError(file: string, code: string, node: Node, detail: string) {
  return new TransitionWhenError(
    `[rango] transition({ when }) at ${file}:${lineColumn(code, node.start)}: ` +
      `\`when\` runs in the browser; ${detail}`,
  );
}

/**
 * Hoist every inline `transition({ when: <function literal> })` of a urls
 * module. Returns null when there is nothing to hoist. Throws a
 * TransitionWhenError for a capture, a server-only import or module-loading
 * expression, an accessor `when`, or a local identifier value.
 */
export async function hoistTransitionWhens(
  code: string,
  id: string,
  deps: HoistTransitionWhenDeps = {},
): Promise<HoistTransitionWhenResult | null> {
  if (!ROUTER_IMPORT_RE.test(code) || !WHEN_RE.test(code)) return null;
  const file = normalizePath(id.split("?", 1)[0]!);
  let program: Node;
  try {
    program = parseAst(code, { lang: parseLang(file) });
  } catch {
    return null;
  }
  if (hasUseClientDirective(program)) return null;

  const { moduleScope, references, scopeOf } = analyzeScopes(program);
  const imports = collectImports(program);
  const sites = findWhenSites(program, scopeOf, moduleScope, imports);
  if (sites.length === 0) return null;

  const s = new MagicString(code);
  const modules: string[] = [];
  const header: string[] = [];

  for (const site of sites) {
    const { prop, value } = site;
    if (prop.kind === "get" || prop.kind === "set") {
      throw whenError(
        file,
        code,
        prop,
        `\`${prop.kind} when()\` is an accessor; \`when\` must be the ` +
          "predicate itself: `when: (ctx) => ...` or `when(ctx) { ... }`.",
      );
    }
    if (value.type === "Identifier") {
      const decl = site.scope.lookup(value.name);
      if (decl && !(decl === moduleScope && imports.has(value.name))) {
        throw whenError(
          file,
          code,
          value,
          `\`${value.name}\` is a server-module binding. Export the predicate ` +
            'from a "use client" module and import it, or write it inline.',
        );
      }
      continue;
    }
    if (!isFunctionLiteral(value)) continue;

    const lexical = findLexicalCapture(value, references, code);
    if (lexical) throw whenError(file, code, lexical.node, lexical.detail);

    // Free references of the literal: everything declared outside it.
    const used = new Map<string, boolean>(); // import local name -> value use
    for (const ref of references) {
      if (ref.node.start < value.start || ref.node.end > value.end) continue;
      const decl = ref.scope.lookup(ref.node.name);
      if (!decl) continue; // a global (window, URL, console, ...)
      if (
        decl.node.start >= value.start &&
        decl.node.end <= value.end &&
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
      throw whenError(
        file,
        code,
        ref.node,
        `\`${ref.node.name}\` is a server-module binding. Read it from ` +
          "`to.params`/`to.state`, or export the predicate from a " +
          '"use client" module.',
      );
    }

    // Re-emit the referenced imports, grouped per source.
    const bySource = new Map<string, string[]>();
    for (const [local, valueUse] of used) {
      const binding = imports.get(local)!;
      if (valueUse) {
        if (
          isServerOnlySpecifier(binding.source) ||
          (await deps.isServerOnlyImport?.(binding.source))
        ) {
          throw whenError(
            file,
            code,
            value,
            `\`${local}\` is imported from "${binding.source}", a server-only ` +
              "module. Import only client-safe modules into an inline " +
              'predicate, or export it from a "use client" module.',
          );
        }
      }
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

    // A method's FunctionExpression spans from its type parameters or
    // parameters; the async/generator markers sit on the property.
    const source = prop.method
      ? `${value.async ? "async " : ""}function${value.generator ? "*" : ""} ` +
        code.slice(value.start, value.end)
      : code.slice(value.start, value.end);
    const index = modules.length;
    modules.push(
      [
        `"use client";`,
        ...[...bySource.values()].flat(),
        `export const ${EXPORT_NAME} = ${source};`,
        "",
      ].join("\n"),
    );
    const local = `${LOCAL_PREFIX}${index}`;
    // The whole property: drops a method's markers and TS wrappers with it.
    s.overwrite(
      prop.start,
      prop.end,
      `${code.slice(prop.key.start, prop.key.end)}: ${local}`,
    );
    header.push(
      `import { ${EXPORT_NAME} as ${local} } from ${JSON.stringify(
        `${file}?${TRANSITION_WHEN_QUERY}=${index}`,
      )};`,
    );
  }

  if (modules.length === 0) return null;

  // After the directive prologue, so a "use server"/"use strict" stays first.
  let insertAt = 0;
  for (const statement of program.body) {
    if (
      statement.type !== "ExpressionStatement" ||
      typeof statement.directive !== "string"
    ) {
      break;
    }
    insertAt = statement.end;
  }
  s.appendLeft(insertAt, `${insertAt ? "\n" : ""}${header.join("\n")}\n`);

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true, source: file }),
    modules,
  };
}

/** The hoisted module index a `?rango-when=N` id names, or null. */
export function parseHoistedWhenId(
  id: string,
): { file: string; index: number } | null {
  const q = id.indexOf("?");
  if (q === -1) return null;
  const params = new URLSearchParams(id.slice(q + 1));
  const raw = params.get(TRANSITION_WHEN_QUERY);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return { file: id.slice(0, q), index: Number(raw) };
}

const SERVER_ONLY_IMPORT_RE = /\bimport\s+["']server-only["']/;

async function readSource(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return null;
  }
}

/** What the RSC transform emitted for a urls file, and the disk source it saw. */
interface EmittedWhens {
  readonly disk: string | null;
  readonly modules: readonly string[];
}

/**
 * The plugin: hoists in the RSC environment (where urls() modules are
 * evaluated) and serves the `?rango-when=N` modules in every environment
 * (RSC, SSR and client all load them).
 *
 * `load` serves the modules the transform emitted, not a re-hoist of the file
 * on disk: the transform hoists the pipeline code, which an earlier plugin
 * may have changed, so re-hoisting the disk source can number the literals
 * differently and serve the wrong one for index N. The disk source is the
 * fallback only when the transform has not seen the current file: an
 * environment loading before the RSC transform ran (the order environments
 * ask in is not fixed), or an edit the RSC environment has not re-transformed
 * yet (serving the last transform would then be stale). The map is per
 * plugin instance, so every environment of one dev server or build shares it.
 */
export function transitionWhenHoistPlugin(): Plugin {
  const emitted = new Map<string, EmittedWhens>();
  return {
    name: "@rangojs/router:transition-when-hoist",
    enforce: "pre",

    async load(id) {
      const hoisted = parseHoistedWhenId(id);
      if (!hoisted) return;
      const file = normalizePath(hoisted.file);
      const disk = await readSource(hoisted.file);
      const entry = emitted.get(file);
      const modules =
        entry && (disk === null || entry.disk === disk)
          ? entry.modules
          : disk === null
            ? undefined
            : (await hoistTransitionWhens(disk, hoisted.file))?.modules;
      const module = modules?.[hoisted.index];
      if (module === undefined) {
        throw new TransitionWhenError(
          `[rango] ${hoisted.file} has no inline transition({ when }) #${hoisted.index}.`,
        );
      }
      return module;
    },

    async transform(code, id) {
      if (this.environment?.name !== "rsc") return;
      if (id.includes("/node_modules/") || parseHoistedWhenId(id)) return;
      const file = normalizePath(id.split("?", 1)[0]!);
      if (!/\.[cm]?[jt]sx?$/.test(file)) return;
      emitted.delete(file);
      const result = await hoistTransitionWhens(code, id, {
        isServerOnlyImport: async (source) => {
          const resolved = await this.resolve(source, id);
          if (!resolved || resolved.external) return false;
          const target = resolved.id.split("?", 1)[0]!;
          if (target.includes("/node_modules/") || target.startsWith("\0")) {
            return false;
          }
          const text = await readSource(target);
          return text !== null && SERVER_ONLY_IMPORT_RE.test(text);
        },
      });
      if (!result) return;
      emitted.set(file, {
        disk: await readSource(file),
        modules: result.modules,
      });
      return { code: result.code, map: result.map };
    },
  };
}
