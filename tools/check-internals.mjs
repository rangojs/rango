#!/usr/bin/env node
// Internals ratchet.
//
// The router internals are being consolidated in place (plan rango-d195): each
// duplicated concept gets one owner module. A cleanup lasts only if new work
// does not add to the duplication, so this check counts four kinds of coupling
// per file and compares them with tools/internals-baseline.json. A count may go
// down and never up; raising one is a baseline diff the owner approves in
// review. File size is not ratcheted: there is no per-file line cap.
//
// Rules (per-file counts):
//
//  1. request-context-object-create. `Object.create(x)` where x is a value
//     typed RequestContext, outside server/render-pass.ts (deriveRenderPass,
//     the one table of what a derived render pass gets fresh and what it
//     shares). Every hand-built derivation is another reset list to keep in
//     step; #684 was a render barrier inherited through the prototype.
//     Scope: packages/rangojs-router/src, tests included.
//
//  2. internal-vi-mock. `vi.mock` or `vi.doMock` of router code: a
//     `@rangojs/*` package, or a relative or root-relative specifier that
//     reaches packages/rangojs-router/src, as a string or as
//     `import("./x.js")`. A root-relative specifier starts at the Vite root,
//     which holds the router source only for the router's own tests. An app's
//     mock of its own module (`./db.js`, `~/lib/db`) and other bare
//     specifiers (the plugin-rsc runtime, `react`, `node:*`) stay allowed;
//     router code is built on production wiring instead. Scope: packages/,
//     tests/, examples/, apps/.
//
//  3. rsc-param-literal. A `_rsc_` name outside wire-params.ts: an identifier
//     (`{ _rsc_partial: "1" }`, `params._rsc_v`), or a string or template
//     literal with the name at its start or after `?` / `&`. The
//     partial-request wire parameter names have one owner. Tests are exempt (a
//     test that spells the name pins the wire format). Scope: non-test source
//     under packages/rangojs-router/src.
//
//  4. browser-import-into-server. A runtime import of browser/ (import,
//     export-from, dynamic import(), require(), `import x = require()`) from
//     server/, rsc/, router/ or cache/, except the shared L0 helpers in
//     BROWSER_L0. The L0 helpers are in scope themselves, so one cannot pull
//     the rest of browser/ into the server graph. `import type`, `export
//     type` and specifier lists that are all `type` are erased by the build
//     and not counted. Scope: non-test source.
//
// Parsing is syntax-only (no Program/TypeChecker), in the style of
// check-no-external-store.mjs, so the scan stays fast. Rule 1 resolves "typed
// RequestContext" from declarations in the same file, up to MAX_DEPTH hops:
// an argument or result typed `RequestContext` (in a union or intersection,
// or through an `as` cast), a parameter or variable so annotated, a call to
// getRequestContext / _getRequestContext / createRequestContext, a call to the
// test kit's makeRequestContext through a named import of
// src/__tests__/kit/request-context, a context derived from one
// (Object.create / Object.assign), and a call to a same-file function whose
// return type or returned value is one of those.
//
// Known misses: rule 1 does not see a context reached through a property
// (`this.ctx`, `opts.reqCtx`), a destructured or caught binding, a helper
// imported from another file (the kit's makeRequestContext aside, and it too
// through a namespace import), a value behind `??`, `||` or `?:`, an
// assignment to an annotated `let`, or another prototype API
// (`Object.setPrototypeOf`, `__proto__`); rule 2 does not see a computed
// specifier, a renamed `vi`, or a path into the router source by an alias,
// an absolute path (`/@fs/...`) or node_modules; rule 3 does not see a name
// assembled at runtime.
//
// Usage:
//   node tools/check-internals.mjs           check against the baseline
//   node tools/check-internals.mjs --update  lower the baseline to every count
//                                            that went down; never raises one
//   node tools/check-internals.mjs --update --allow-raise
//                                            write the current counts, raises
//                                            included (a new, moved or renamed
//                                            file); the owner approves the diff
//
// A count below its baseline fails the check too: --update locks the gain in,
// so a later change cannot spend it. A merge conflict in the baseline
// resolves by taking either side and running --update again, with
// --allow-raise when the side dropped carried an approved raise.

import ts from "typescript";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/e2e-bucketing-scan.mjs";

const BASELINE_PATH = "tools/internals-baseline.json";
const BASELINE_VERSION = 1;

const ROOTS = ["packages/", "tests/", "examples/", "apps/"];
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const ROUTER_ROOT = "packages/rangojs-router/";
const SRC = `${ROUTER_ROOT}src/`;

export const RULE_OBJECT_CREATE = "request-context-object-create";
export const RULE_VI_MOCK = "internal-vi-mock";
export const RULE_RSC_LITERAL = "rsc-param-literal";
export const RULE_BROWSER_IMPORT = "browser-import-into-server";
const RULES = [
  RULE_OBJECT_CREATE,
  RULE_VI_MOCK,
  RULE_RSC_LITERAL,
  RULE_BROWSER_IMPORT,
];

/** The one module allowed to derive a request context (plan S5, deriveRenderPass). */
const RENDER_PASS_FILE = `${SRC}server/render-pass.ts`;
/** The one module allowed to spell the `_rsc_*` wire parameter names (plan S16). */
const WIRE_PARAMS_FILE = `${SRC}wire-params.ts`;

const SERVER_DIRS = ["server/", "rsc/", "router/", "cache/"].map(
  (d) => SRC + d,
);
const BROWSER_DIR = `${SRC}browser/`;
/**
 * Pure helpers that live in browser/ and are shared by both graphs (layer L0
 * of the target architecture, rango-d194 section 2). They stay where they are
 * and are listed by path, extension stripped.
 */
const BROWSER_L0 = new Set([
  `${SRC}browser/cookie-name`,
  `${SRC}browser/intercept-utils`,
  `${SRC}browser/react/filter-segment-order`,
]);

const REQUEST_CONTEXT_TYPE = "RequestContext";
const REQUEST_CONTEXT_FACTORIES = new Set([
  "getRequestContext",
  "_getRequestContext",
  "createRequestContext",
]);
/**
 * The internal test kit's factory, matched through the importing file's named
 * import of KIT_REQUEST_CONTEXT_MODULE, so a same-named function from another
 * module is not taken for it.
 */
const KIT_REQUEST_CONTEXT_FACTORY = "makeRequestContext";
const KIT_REQUEST_CONTEXT_MODULE = `${SRC}__tests__/kit/request-context`;
/** Declaration hops rule 1 follows (variable -> helper -> return -> ...). */
const MAX_DEPTH = 4;

const RSC_PARAM = /(?:^|[?&])_rsc_/;
/** After a `${}` substitution only a query separator starts a name. */
const RSC_PARAM_INNER = /[?&]_rsc_/;
const VI_MOCK_TEXT = /\bvi\s*\.\s*(?:mock|doMock)\b/;

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const withoutExt = (p) => p.replace(/\.[cm]?[jt]sx?$/, "");

/** The repo path a relative `specifier` names from `importer`, extension stripped; undefined for a bare one. */
function resolveRelative(importer, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  return withoutExt(
    path.posix.normalize(
      path.posix.join(path.posix.dirname(importer), specifier),
    ),
  );
}

function scriptKindFor(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function isStringLike(node) {
  return (
    node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  );
}

function skipWrappers(expr) {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

function isTestFile(relPath) {
  return (
    relPath.split("/").includes("__tests__") ||
    /\.(?:test|spec|rsc-test)\.[cm]?[jt]sx?$/.test(path.posix.basename(relPath))
  );
}

/** `Object.<method>(...)`. */
function isObjectCall(call, method) {
  const callee = skipWrappers(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === method &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object"
  );
}

// ---- rule 1: "typed RequestContext", by syntax -----------------------------

/** True when a binding name, an identifier or a destructuring pattern, binds `name`. */
function bindsName(binding, name) {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (el) => !ts.isOmittedExpression(el) && bindsName(el.name, name),
  );
}

/**
 * The nearest declaration of `name` visible from `use`: a parameter, a
 * variable (loop and catch variables included) or a function declaration.
 * Undefined when the name is not declared in this file (an import, a global).
 */
function findDeclaration(use, name) {
  const named = (decl) => bindsName(decl.name, name);
  for (let scope = use.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const param = scope.parameters.find(named);
      if (param) return param;
    }
    if (
      (ts.isForStatement(scope) ||
        ts.isForOfStatement(scope) ||
        ts.isForInStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer)
    ) {
      const decl = scope.initializer.declarations.find(named);
      if (decl) return decl;
    }
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration &&
      named(scope.variableDeclaration)
    ) {
      return scope.variableDeclaration;
    }
    if (
      ts.isBlock(scope) ||
      ts.isSourceFile(scope) ||
      ts.isModuleBlock(scope) ||
      ts.isCaseClause(scope) ||
      ts.isDefaultClause(scope)
    ) {
      for (const stmt of scope.statements) {
        if (ts.isVariableStatement(stmt)) {
          const decl = stmt.declarationList.declarations.find(named);
          if (decl) return decl;
        } else if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
          return stmt;
        }
      }
    }
  }
  return undefined;
}

/**
 * `RequestContext`, `RequestContext<E>` or `ns.RequestContext`, alone or in a
 * union or intersection. Not `RequestContext["use"]` or `Partial<...>`.
 */
function typeIsRequestContext(type) {
  if (!type) return false;
  if (ts.isParenthesizedTypeNode(type)) return typeIsRequestContext(type.type);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some(typeIsRequestContext);
  }
  if (!ts.isTypeReferenceNode(type)) return false;
  const name = type.typeName;
  return (
    (ts.isIdentifier(name) ? name.text : name.right.text) ===
    REQUEST_CONTEXT_TYPE
  );
}

function identifierIsRequestContext(use, name, depth) {
  if (depth > MAX_DEPTH) return false;
  const decl = findDeclaration(use, name);
  // A destructured binding's type is a part of its declaration's, unresolved.
  if (!decl || ts.isFunctionDeclaration(decl) || !ts.isIdentifier(decl.name)) {
    return false;
  }
  return (
    typeIsRequestContext(decl.type) ||
    expressionIsRequestContext(decl.initializer, depth)
  );
}

/** The function a declaration names: `function f`, `const f = () =>`, `const f = function`. */
function functionOf(decl) {
  if (ts.isFunctionDeclaration(decl)) return decl;
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = skipWrappers(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return undefined;
}

/** Return statements of `fn` itself, not of functions nested in it. */
function ownReturns(fn) {
  const out = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return out;
}

function functionReturnsRequestContext(fn, depth) {
  if (depth > MAX_DEPTH) return false;
  // A return type annotation is the function's contract; trust it either way.
  if (fn.type) return typeIsRequestContext(fn.type);
  if (fn.body && !ts.isBlock(fn.body)) {
    return expressionIsRequestContext(fn.body, depth);
  }
  return ownReturns(fn).some((r) =>
    expressionIsRequestContext(r.expression, depth),
  );
}

function callIsRequestContext(call, depth) {
  // Object.create(x) and Object.assign(x, ...) hand back a child of x, or x.
  if (isObjectCall(call, "create") || isObjectCall(call, "assign")) {
    return expressionIsRequestContext(call.arguments[0], depth);
  }
  const callee = skipWrappers(call.expression);
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  if (name === undefined) return false;
  if (REQUEST_CONTEXT_FACTORIES.has(name)) return true;
  if (!ts.isIdentifier(callee)) return false;
  const decl = findDeclaration(callee, name);
  if (!decl) return importsKitFactoryAs(callee.getSourceFile(), name);
  const fn = functionOf(decl);
  return fn !== undefined && functionReturnsRequestContext(fn, depth + 1);
}

/** `sf` binds `local` with `import { makeRequestContext [as local] }` from the test kit. */
function importsKitFactoryAs(sf, local) {
  return sf.statements.some((stmt) => {
    if (
      !ts.isImportDeclaration(stmt) ||
      !isStringLike(stmt.moduleSpecifier) ||
      resolveRelative(sf.fileName, stmt.moduleSpecifier.text) !==
        KIT_REQUEST_CONTEXT_MODULE
    ) {
      return false;
    }
    const named = stmt.importClause?.namedBindings;
    return (
      named !== undefined &&
      ts.isNamedImports(named) &&
      named.elements.some(
        (el) =>
          el.name.text === local &&
          (el.propertyName ?? el.name).text === KIT_REQUEST_CONTEXT_FACTORY,
      )
    );
  });
}

function expressionIsRequestContext(expr, depth) {
  if (!expr || depth > MAX_DEPTH) return false;
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
      expr = expr.expression;
    } else if (
      ts.isAsExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isSatisfiesExpression(expr)
    ) {
      // `ctx as object` is still the context; `x as RequestContext` says so.
      if (typeIsRequestContext(expr.type)) return true;
      expr = expr.expression;
    } else {
      break;
    }
  }
  if (ts.isIdentifier(expr)) {
    return identifierIsRequestContext(expr, expr.text, depth + 1);
  }
  if (ts.isCallExpression(expr)) return callIsRequestContext(expr, depth + 1);
  return false;
}

function enclosingFunction(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) return cur;
  }
  return undefined;
}

/** The value of `call` lands somewhere typed RequestContext. */
function resultIsRequestContext(call) {
  let cur = call;
  for (let p = cur.parent; p; cur = p, p = cur.parent) {
    if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p)) continue;
    if (
      ts.isAsExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isSatisfiesExpression(p)
    ) {
      if (typeIsRequestContext(p.type)) return true;
      continue;
    }
    // Object.assign(Object.create(x), {...}) returns its first argument.
    if (
      ts.isCallExpression(p) &&
      p.arguments[0] === cur &&
      isObjectCall(p, "assign")
    ) {
      continue;
    }
    if (ts.isVariableDeclaration(p) && p.initializer === cur) {
      return typeIsRequestContext(p.type);
    }
    if (ts.isReturnStatement(p)) {
      return typeIsRequestContext(enclosingFunction(p)?.type);
    }
    if (ts.isArrowFunction(p) && p.body === cur) {
      return typeIsRequestContext(p.type);
    }
    return false;
  }
  return false;
}

function isObjectCreateOfRequestContext(call) {
  return (
    isObjectCall(call, "create") &&
    (expressionIsRequestContext(call.arguments[0], 0) ||
      resultIsRequestContext(call))
  );
}

// ---- rule 2 ----------------------------------------------------------------

/** The specifier of `vi.mock(...)` / `vi.doMock(...)`, or undefined. */
function viMockSpecifier(call) {
  const callee = skipWrappers(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    (callee.name.text !== "mock" && callee.name.text !== "doMock") ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "vi"
  ) {
    return undefined;
  }
  const first = call.arguments[0];
  if (isStringLike(first)) return first.text;
  // vi.mock(import("./x.js"), ...): the typed form takes the module promise.
  if (
    first !== undefined &&
    ts.isCallExpression(first) &&
    first.expression.kind === ts.SyntaxKind.ImportKeyword &&
    isStringLike(first.arguments[0])
  ) {
    return first.arguments[0].text;
  }
  return undefined;
}

/**
 * True when mocking `specifier` from `importer` replaces router code: a
 * `@rangojs/*` package, or a relative or root-relative path into the router
 * source. Vitest resolves a root-relative path from the Vite root. The only
 * root that holds the router source is the router package's own: its vitest
 * configs sit in ROUTER_ROOT and run src/** alone, so only a file under SRC
 * reaches the source that way.
 */
function mocksRouterCode(importer, specifier) {
  if (specifier.startsWith("@rangojs/")) return true;
  const from = specifier.startsWith(".")
    ? path.posix.dirname(importer)
    : specifier.startsWith("/") && importer.startsWith(SRC)
      ? ROUTER_ROOT
      : undefined;
  return (
    from !== undefined && `${path.posix.join(from, specifier)}/`.startsWith(SRC)
  );
}

// ---- rule 4 ----------------------------------------------------------------

/** True when `specifier`, imported from `importer`, is browser/ beyond the L0 helpers. */
function importsBrowser(importer, specifier) {
  const target = resolveRelative(importer, specifier);
  return (
    target !== undefined &&
    `${target}/`.startsWith(BROWSER_DIR) &&
    !BROWSER_L0.has(target)
  );
}

/** Erased by the build: `import type`, `export type`, or a non-empty list of `type` specifiers only. */
function isTypeOnly(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const named = clause.namedBindings;
    return (
      !clause.name &&
      named !== undefined &&
      ts.isNamedImports(named) &&
      named.elements.length > 0 &&
      named.elements.every((el) => el.isTypeOnly)
    );
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((el) => el.isTypeOnly)
  );
}

// ---- scan ------------------------------------------------------------------

/** All four rules over one file. Hits carry file, line, rule and message. */
export function scanSource(relPath, text) {
  const inSrc = relPath.startsWith(SRC) && !isTestFile(relPath);
  const want = {
    objectCreate:
      relPath.startsWith(SRC) &&
      relPath !== RENDER_PASS_FILE &&
      text.includes("Object.create"),
    viMock: ROOTS.some((r) => relPath.startsWith(r)) && VI_MOCK_TEXT.test(text),
    literal: inSrc && relPath !== WIRE_PARAMS_FILE && text.includes("_rsc_"),
    // An L0 helper imports its browser/ siblings without "browser" in the path.
    browserImport:
      inSrc &&
      (BROWSER_L0.has(withoutExt(relPath)) ||
        (SERVER_DIRS.some((d) => relPath.startsWith(d)) &&
          text.includes("browser"))),
  };
  const hits = [];
  if (!Object.values(want).some(Boolean)) return hits;

  const sf = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(relPath),
  );
  const push = (node, rule, message) => {
    hits.push({ file: relPath, line: lineOf(sf, node), rule, message });
  };
  const browserImport = (node, specifier, how) => {
    if (importsBrowser(relPath, specifier)) {
      push(
        node,
        RULE_BROWSER_IMPORT,
        `${how} of "${specifier}" puts browser/ code in the server graph`,
      );
    }
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (want.objectCreate && isObjectCreateOfRequestContext(node)) {
        push(
          node,
          RULE_OBJECT_CREATE,
          `${node.getText(sf).split("\n")[0].slice(0, 60)} derives a request context outside server/render-pass.ts`,
        );
      }
      if (want.viMock) {
        const spec = viMockSpecifier(node);
        if (spec !== undefined && mocksRouterCode(relPath, spec)) {
          push(
            node,
            RULE_VI_MOCK,
            `${skipWrappers(node.expression).getText(sf)} of internal module "${spec}"`,
          );
        }
      }
      const first = node.arguments[0];
      if (want.browserImport && isStringLike(first)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          browserImport(node, first.text, "dynamic import");
        } else if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require"
        ) {
          browserImport(node, first.text, "require");
        }
      }
    } else if (
      want.browserImport &&
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      isStringLike(node.moduleSpecifier) &&
      !isTypeOnly(node)
    ) {
      browserImport(
        node,
        node.moduleSpecifier.text,
        ts.isImportDeclaration(node) ? "import" : "export-from",
      );
    } else if (
      want.browserImport &&
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isStringLike(node.moduleReference.expression)
    ) {
      browserImport(
        node,
        node.moduleReference.expression.text,
        "import = require",
      );
    }

    if (want.literal) {
      const match =
        ts.isIdentifier(node) ||
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node)
          ? RSC_PARAM.test(node.text)
          : (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
            RSC_PARAM_INNER.test(node.text);
      if (match) {
        push(node, RULE_RSC_LITERAL, `"${node.text.slice(0, 40)}"`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

// ---- baseline --------------------------------------------------------------

/** Per-rule, per-file counts: { [rule]: { [file]: n } }, files sorted, zeros omitted. */
export function countHits(hits) {
  const counts = Object.fromEntries(RULES.map((r) => [r, {}]));
  for (const h of hits) {
    counts[h.rule][h.file] = (counts[h.rule][h.file] ?? 0) + 1;
  }
  for (const rule of RULES) {
    counts[rule] = Object.fromEntries(
      Object.entries(counts[rule]).sort(([a], [b]) => byCodeUnit(a, b)),
    );
  }
  return counts;
}

/** Shape problems in a parsed baseline; empty when it is usable. */
export function validateBaseline(baseline) {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    return ["the baseline is not a JSON object"];
  }
  const problems = [];
  if (baseline.version !== BASELINE_VERSION) {
    problems.push(`"version" is ${baseline.version}, expected 1`);
  }
  const rules = baseline.rules;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    return [...problems, `"rules" is not an object`];
  }
  for (const [rule, files] of Object.entries(rules)) {
    if (!RULES.includes(rule)) {
      problems.push(`unknown rule "${rule}"`);
      continue;
    }
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      problems.push(`"${rule}" is not an object`);
      continue;
    }
    for (const [file, n] of Object.entries(files)) {
      if (!Number.isInteger(n) || n < 1) {
        problems.push(`"${rule}" > "${file}" is ${n}, expected a count >= 1`);
      }
    }
  }
  return problems;
}

/** { rule, file, was, now } for every file in the baseline or the counts, in order; a missing entry is 0. */
function* entries(baseline, counts) {
  for (const rule of RULES) {
    const base = baseline?.rules?.[rule] ?? {};
    const cur = counts[rule] ?? {};
    const files = new Set([...Object.keys(base), ...Object.keys(cur)]);
    for (const file of [...files].sort(byCodeUnit)) {
      yield { rule, file, was: base[file] ?? 0, now: cur[file] ?? 0 };
    }
  }
}

/** `increases`: counts above the baseline. `decreases`: below it (the baseline is stale). */
export function compareToBaseline(baseline, counts) {
  const increases = [];
  const decreases = [];
  for (const e of entries(baseline, counts)) {
    if (e.now > e.was) increases.push(e);
    else if (e.now < e.was) decreases.push(e);
  }
  return { increases, decreases };
}

/**
 * The baseline --update writes. Without `allowRaise` every entry becomes
 * min(baseline, now): gains are locked in and raises stay at the baseline,
 * listed in `refused`. With `allowRaise` it is the current counts.
 */
export function nextBaseline(baseline, counts, allowRaise) {
  const rules = Object.fromEntries(RULES.map((r) => [r, {}]));
  const refused = [];
  for (const e of entries(baseline, counts)) {
    if (!allowRaise && e.now > e.was) refused.push(e);
    const n = allowRaise ? e.now : Math.min(e.was, e.now);
    if (n > 0) rules[e.rule][e.file] = n;
  }
  return { baseline: { version: BASELINE_VERSION, rules }, refused };
}

const describe = (d) => `${d.rule}  ${d.file}  baseline ${d.was}, now ${d.now}`;

/** The check's verdict and its output lines. */
export function report(baseline, hits, scanned) {
  const counts = countHits(hits);
  const { increases, decreases } = compareToBaseline(baseline, counts);
  const lines = [];
  for (const d of increases) {
    lines.push(describe(d));
    for (const h of hits) {
      if (h.rule === d.rule && h.file === d.file) {
        lines.push(`  ${h.file}:${h.line}  ${h.message}`);
      }
    }
  }
  if (increases.length > 0) {
    lines.push(
      `check-internals: FAILED (${increases.length} count(s) above the baseline). Use the shared seam instead of adding a copy (rules at the top of tools/check-internals.mjs). A deliberate raise is a baseline diff the owner approves: node tools/check-internals.mjs --update --allow-raise`,
    );
  }
  for (const d of decreases) lines.push(describe(d));
  if (decreases.length > 0) {
    lines.push(
      `check-internals: FAILED (${decreases.length} count(s) below the baseline). Lock the gain in: node tools/check-internals.mjs --update`,
    );
  }
  const ok = increases.length === 0 && decreases.length === 0;
  if (ok) {
    const totals = RULES.map(
      (r) => `${r} ${Object.values(counts[r]).reduce((sum, n) => sum + n, 0)}`,
    ).join(", ");
    lines.push(`check-internals: OK (${scanned} files scanned; ${totals})`);
  }
  return { ok, lines };
}

// ---- repo ------------------------------------------------------------------

/**
 * Tracked files only, as CI sees them: a local --update must not write counts
 * for an untracked file the commit leaves out.
 */
function listFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");
  // An unmerged path is listed once per stage.
  return [...new Set(out.split("\0").filter(Boolean))].filter(
    (f) =>
      ROOTS.some((r) => f.startsWith(r)) &&
      CODE_EXT.test(f) &&
      !f.endsWith(".d.ts") &&
      !f.split("/").some((s) => s === "node_modules" || s === "dist"),
  );
}

function scanRepo() {
  const hits = [];
  let scanned = 0;
  for (const rel of listFiles()) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    scanned++;
    hits.push(...scanSource(rel, readFileSync(abs, "utf8")));
  }
  return { hits, scanned };
}

/** { baseline } or { problems }; a missing file is an empty baseline. */
function readBaseline() {
  const abs = path.join(REPO_ROOT, BASELINE_PATH);
  if (!existsSync(abs)) return { baseline: undefined };
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    return { problems: [`not valid JSON: ${err.message}`] };
  }
  const problems = validateBaseline(baseline);
  return problems.length > 0 ? { problems } : { baseline };
}

function main(argv) {
  const known = new Set(["--update", "--allow-raise"]);
  const unknown = argv.filter((a) => !known.has(a));
  const update = argv.includes("--update");
  const allowRaise = argv.includes("--allow-raise");
  if (unknown.length > 0 || (allowRaise && !update)) {
    console.log(
      "usage: node tools/check-internals.mjs [--update [--allow-raise]]",
    );
    process.exit(2);
  }

  const read = readBaseline();
  if (read.problems) {
    for (const p of read.problems) console.log(`${BASELINE_PATH}: ${p}`);
    console.log(`check-internals: FAILED (${BASELINE_PATH} is malformed)`);
    process.exit(1);
  }
  const { hits, scanned } = scanRepo();

  if (update) {
    const next = nextBaseline(read.baseline, countHits(hits), allowRaise);
    writeFileSync(
      path.join(REPO_ROOT, BASELINE_PATH),
      `${JSON.stringify(next.baseline, null, 2)}\n`,
    );
    console.log(`check-internals: wrote ${BASELINE_PATH} (${scanned} files)`);
    if (next.refused.length > 0) {
      for (const d of next.refused) console.log(describe(d));
      console.log(
        `check-internals: --update kept the ${next.refused.length} count(s) above at their baseline. Remove the new coupling, or raise them with --update --allow-raise for the owner to approve.`,
      );
      process.exit(1);
    }
    return;
  }

  const { ok, lines } = report(read.baseline, hits, scanned);
  for (const line of lines) console.log(line);
  if (!ok) process.exit(1);
}

// import.meta.url is the resolved path; resolve argv[1] too, or a run through
// a symlinked checkout skips main() and exits 0 without scanning.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main(process.argv.slice(2));
}
