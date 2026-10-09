#!/usr/bin/env node
// External-store tripwire.
//
// External stores are forbidden in this repo. Every hook keeps its value in
// React state (useState / useReducer / useOptimistic / context / props); the
// value reaches React through setState or dispatch, typically from an effect
// subscription. A lazy useState/useReducer initializer may read a store once.
// The only escapes are startTransition and useOptimistic.
//
// Rules:
//
//  1. no-use-sync-external-store. Any identifier named useSyncExternalStore or
//     useSyncExternalStoreWithSelector (import, re-export, member access
//     `x.useSyncExternalStore` on any receiver, `React.x`, `React["x"]`,
//     destructuring, plain reference), repo-wide in packages/, tests/,
//     examples/, apps/, tools/.
//
//  2. no-store-package. An import, export-from, require(), dynamic import()
//     or `import x = require()` of the `use-sync-external-store` shim or a
//     store library (STORE_PACKAGES, `@nanostores/*`), or any subpath.
//
//  3. no-store-dependency. A package.json that lists one of those packages in
//     dependencies, devDependencies, peerDependencies or
//     optionalDependencies.
//
//  4. no-render-time-store-read. In router client hooks and components
//     (browser/react/, client-urls/, use-loader.tsx; tests excluded), a
//     direct call in the render body of eventController.getState(), or of
//     getActionState / getHandleState / getLocation / getHydrationSnapshot on
//     any receiver. A render body reading mutable controller state is an
//     external store read in disguise. Functions that run during render are
//     walked: an immediately invoked function, a useMemo factory and the
//     callback of an array-iteration method (map, filter, reduce, forEach,
//     find, ...). Effects, callbacks (useCallback, startTransition), event
//     handlers and lazy useState/useReducer initializers are not walked (the
//     initializer is the sanctioned once-on-mount read).
//
// Parsing is syntax-only (no Program/TypeChecker), so the scan stays fast
// over thousands of files. Identifiers never come from comments or string
// literals, and ts.forEachChild does not descend into JSDoc, so
// `{@link useSyncExternalStore}` does not match.
//
// Known misses: `fn.call(...)` / `fn.apply(...)` IIFEs, a class component's
// render() (class bodies are not walked), and
// `import { "useSyncExternalStore" as u } from "react"` (a string-literal
// import name is not an Identifier).
//
// Not seen: rule 4 only inspects the component/hook's own body. A nested
// helper function called during render (`function read() { return
// ctx.eventController.getState() }` then `read()` in the body) is not
// followed, nor is a read through an alias (`const c = ctx.eventController;
// c.getState()`), nor a component whose name does not match
// /^(use[A-Z0-9]|[A-Z])/. Rules 1-2 do not see a dynamically built name
// (`React[name]`).
//
// There is no allowlist: the rule has no exceptions, tests included.

import ts from "typescript";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/e2e-bucketing-scan.mjs";

const ROOTS = ["packages/", "tests/", "examples/", "apps/", "tools/"];
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const STORE_HOOKS = new Set([
  "useSyncExternalStore",
  "useSyncExternalStoreWithSelector",
]);
const STORE_PACKAGES = [
  "use-sync-external-store",
  "zustand",
  "jotai",
  "valtio",
  "redux",
  "@reduxjs/toolkit",
  "react-redux",
  "mobx",
  "mobx-react",
  "mobx-react-lite",
  "nanostores",
  "effector",
  "effector-react",
  "recoil",
  "@tanstack/store",
  "@tanstack/react-store",
  "@xstate/store",
  "@legendapp/state",
];
const STORE_SCOPES = ["@nanostores/"];
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const RULE_HOOK = "no-use-sync-external-store";
const RULE_PACKAGE = "no-store-package";
const RULE_DEP = "no-store-dependency";
const RULE_RENDER = "no-render-time-store-read";

const RENDER_READ_DIRS = [
  "packages/rangojs-router/src/browser/react/",
  "packages/rangojs-router/src/client-urls/",
];
const RENDER_READ_FILES = new Set([
  "packages/rangojs-router/src/use-loader.tsx",
]);
const ITERATION_METHODS = new Set([
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "forEach",
  "flatMap",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
]);
const COMPONENT_NAME = /^(use[A-Z0-9]|[A-Z])/;
const ACTION_READERS = new Set([
  "getActionState",
  "getHandleState",
  "getLocation",
  "getHydrationSnapshot",
]);

function scriptKindFor(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function isStoreSpecifier(text) {
  return (
    STORE_SCOPES.some((scope) => text.startsWith(scope)) ||
    STORE_PACKAGES.some((pkg) => text === pkg || text.startsWith(`${pkg}/`))
  );
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
    ts.isSatisfiesExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

/** A key or member declaration named like the hook is a name, not a reference. */
function isDeclarationName(node) {
  const p = node.parent;
  return (
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)) &&
    p.name === node
  );
}

function describeHookReference(node, name) {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) {
    const decl = parent.parent.parent.parent;
    const mod =
      decl && ts.isImportDeclaration(decl) && isStringLike(decl.moduleSpecifier)
        ? decl.moduleSpecifier.text
        : "?";
    return `named import of ${name} from "${mod}"`;
  }
  if (ts.isExportSpecifier(parent)) return `re-export of ${name}`;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return `member access ${parent.expression.getText()}.${name}`;
  }
  if (ts.isBindingElement(parent)) return `destructured ${name}`;
  return `reference to ${name}`;
}

function inRenderReadScope(relPath) {
  if (relPath.split("/").includes("__tests__")) return false;
  if (/\.(?:test|spec)\./.test(path.posix.basename(relPath))) return false;
  return (
    RENDER_READ_FILES.has(relPath) ||
    RENDER_READ_DIRS.some((d) => relPath.startsWith(d))
  );
}

function isFunctionLike(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

function wrapperCallName(call) {
  const callee = skipWrappers(call.expression);
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  return name === "forwardRef" || name === "memo" ? name : undefined;
}

/** Name of a component/hook function node, or undefined when not a candidate. */
function componentName(fn) {
  if (
    !ts.isFunctionDeclaration(fn) &&
    !ts.isFunctionExpression(fn) &&
    !ts.isArrowFunction(fn)
  ) {
    return undefined;
  }
  // Climb through parens and forwardRef/memo wrappers.
  let wrapped = false;
  let cur = fn;
  while (
    cur.parent &&
    (ts.isParenthesizedExpression(cur.parent) ||
      (ts.isCallExpression(cur.parent) &&
        cur.parent.arguments.includes(cur) &&
        wrapperCallName(cur.parent)))
  ) {
    if (ts.isCallExpression(cur.parent)) wrapped = true;
    cur = cur.parent;
  }
  const own = !ts.isArrowFunction(fn) && fn.name ? fn.name.text : undefined;
  const declared =
    cur.parent &&
    ts.isVariableDeclaration(cur.parent) &&
    cur.parent.initializer === cur &&
    ts.isIdentifier(cur.parent.name)
      ? cur.parent.name.text
      : undefined;
  // Wrapped functions take the variable name first; plain ones their own.
  const name = wrapped ? (declared ?? own) : (own ?? declared);
  if (wrapped) return name ?? "anonymous component";
  if (name && COMPONENT_NAME.test(name)) return name;
  return undefined;
}

function renderReadCallee(call) {
  const callee = skipWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  const recv = skipWrappers(callee.expression);
  let hit = false;
  if (method === "getState") {
    hit =
      (ts.isIdentifier(recv) && recv.text === "eventController") ||
      (ts.isPropertyAccessExpression(recv) &&
        recv.name.text === "eventController");
  } else if (ACTION_READERS.has(method)) {
    hit = true;
  }
  return hit ? callee.getText() : undefined;
}

/** True for a function that runs synchronously during render: an IIFE or a useMemo factory. */
function runsDuringRender(fn) {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) {
    return false;
  }
  let cur = fn;
  while (cur.parent && ts.isParenthesizedExpression(cur.parent)) {
    cur = cur.parent;
  }
  const parent = cur.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (parent.expression === cur) return true;
  if (parent.arguments[0] !== cur) return false;
  const callee = skipWrappers(parent.expression);
  if (ts.isIdentifier(callee)) return callee.text === "useMemo";
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return (
    callee.name.text === "useMemo" || ITERATION_METHODS.has(callee.name.text)
  );
}

function scanRenderReads(sf, relPath, hits) {
  const checkBody = (fn, name) => {
    const visit = (node) => {
      if (isFunctionLike(node) && !runsDuringRender(node)) return;
      if (ts.isCallExpression(node)) {
        const callee = renderReadCallee(node);
        if (callee) {
          hits.push({
            file: relPath,
            line: lineOf(sf, node),
            rule: RULE_RENDER,
            message: `${callee}() called during render in ${name}; read it in an effect/subscription or a lazy useState initializer`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
  };
  const find = (node) => {
    const name = componentName(node);
    if (name) checkBody(node, name);
    ts.forEachChild(node, find);
  };
  find(sf);
}

/** Rules 1, 2 and (in scope) 4 over one source text. */
export function scanSource(relPath, text) {
  const sf = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(relPath),
  );
  const hits = [];
  const push = (node, rule, message) => {
    hits.push({ file: relPath, line: lineOf(sf, node), rule, message });
  };
  const pkgHit = (node, spec, how) =>
    push(node, RULE_PACKAGE, `${how} of "${spec}"`);

  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      STORE_HOOKS.has(node.text) &&
      !isDeclarationName(node)
    ) {
      push(node, RULE_HOOK, describeHookReference(node, node.text));
    } else if (
      ts.isElementAccessExpression(node) &&
      isStringLike(node.argumentExpression) &&
      STORE_HOOKS.has(node.argumentExpression.text)
    ) {
      const name = node.argumentExpression.text;
      push(
        node,
        RULE_HOOK,
        `element access ${node.expression.getText()}["${name}"]`,
      );
    } else if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      isStringLike(node.moduleSpecifier) &&
      isStoreSpecifier(node.moduleSpecifier.text)
    ) {
      pkgHit(
        node,
        node.moduleSpecifier.text,
        ts.isImportDeclaration(node) ? "import" : "export-from",
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isStringLike(node.moduleReference.expression) &&
      isStoreSpecifier(node.moduleReference.expression.text)
    ) {
      pkgHit(node, node.moduleReference.expression.text, "import = require");
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      isStringLike(node.arguments[0]) &&
      isStoreSpecifier(node.arguments[0].text)
    ) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        pkgHit(node, node.arguments[0].text, "dynamic import");
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        pkgHit(node, node.arguments[0].text, "require");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (inRenderReadScope(relPath)) scanRenderReads(sf, relPath, hits);
  return hits;
}

/** Rule 3 over one package.json text. */
export function scanPackageJson(relPath, text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const hits = [];
  for (const field of DEP_FIELDS) {
    const deps = json?.[field];
    if (!deps || typeof deps !== "object") continue;
    const fieldIdx = Math.max(text.indexOf(`"${field}"`), 0);
    for (const key of Object.keys(deps)) {
      if (!isStoreSpecifier(key)) continue;
      const idx = text.indexOf(`"${key}"`, fieldIdx);
      const line = idx < 0 ? 1 : text.slice(0, idx).split("\n").length;
      hits.push({
        file: relPath,
        line,
        rule: RULE_DEP,
        message: `${field} lists ${key}`,
      });
    }
  }
  return hits;
}

function listFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");
  const files = out.split("\0").filter(Boolean);
  const inScope = (f) =>
    !f.split("/").some((s) => s === "node_modules" || s === "dist");
  const inRoots = (f) => ROOTS.some((r) => f.startsWith(r));
  const code = files.filter(
    (f) => inRoots(f) && CODE_EXT.test(f) && inScope(f),
  );
  const pkgs = files.filter(
    (f) =>
      (f === "package.json" || (inRoots(f) && f.endsWith("/package.json"))) &&
      inScope(f),
  );
  return { code, pkgs };
}

function main() {
  const { code, pkgs } = listFiles();
  const hits = [];
  let scanned = 0;
  for (const rel of code) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    scanned++;
    hits.push(...scanSource(rel, readFileSync(abs, "utf8")));
  }
  for (const rel of pkgs) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    scanned++;
    hits.push(...scanPackageJson(rel, readFileSync(abs, "utf8")));
  }
  hits.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule),
  );

  for (const h of hits) {
    console.log(`${h.file}:${h.line}  ${h.rule}  ${h.message}`);
  }
  if (hits.length > 0) {
    console.log(
      `check-no-external-store: FAILED (${hits.length} hit(s), ${scanned} files scanned). External stores are forbidden: keep hook values in React state (see tools/check-no-external-store.mjs).`,
    );
    process.exit(1);
  }
  console.log(`check-no-external-store: OK (${scanned} files scanned)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
