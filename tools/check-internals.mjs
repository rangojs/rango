#!/usr/bin/env node
// Internals ratchet.
//
// The router internals are being consolidated in place (plan rango-d195, target
// architecture rango-d194). A cleanup lasts only if new work lands on the new
// seams, so this check counts four kinds of coupling per file and fails when
// any count grows past tools/internals-baseline.json. A count may go down and
// never up. There is no per-file line cap: size is not what we ratchet.
//
// Rules (counts are per file):
//
//  1. request-context-object-create. `Object.create(x)` where x is a value
//     typed RequestContext, outside server/render-pass.ts. A derived request
//     context is built by `deriveRenderPass`, from one table of what each
//     purpose gets fresh and what it shares. A hand-written derivation is a
//     new reset list (#684: a render barrier inherited through the prototype).
//     Scope: packages/rangojs-router/src, tests included.
//
//  2. internal-vi-mock. `vi.mock(spec)` / `vi.doMock(spec)` with a relative
//     specifier (an internal module). Mock only the plugin-rsc runtime, `react`
//     and platform globals; build everything else with the test kit on
//     production wiring. Scope: every tracked file under packages/, tests/,
//     examples/ and apps/.
//
//  3. rsc-param-literal. A string literal (or template literal head) that
//     starts with `_rsc_`, outside wire-params.ts. The partial-request wire
//     parameter names have one owner. Scope: non-test source under
//     packages/rangojs-router/src.
//
//  4. browser-import-into-server. A runtime import (import, export-from,
//     dynamic import, require) from browser/ into server/, rsc/, router/ or
//     cache/, except the L0 helper list below. `import type` and `export type`
//     are not runtime. Scope: non-test source under packages/rangojs-router/src.
//
// Parsing is syntax-only (no Program/TypeChecker), in the style of
// check-no-external-store.mjs. "Typed RequestContext" is resolved by syntax:
// the argument is an identifier whose declaration in the same file (parameter
// or variable) is annotated with RequestContext or initialized from
// getRequestContext / createRequestContext, or the Object.create call (through
// Object.assign / `as` wrappers) initializes a declaration annotated
// RequestContext. Known misses: a context reached through a property
// (`this.ctx`), a destructured parameter, a value typed by inference from
// another file, and a computed `vi.mock` specifier.
//
// Usage:
//   node tools/check-internals.mjs                 check against the baseline
//   node tools/check-internals.mjs --update        lower the baseline to the
//                                                  current counts; refuses to
//                                                  raise any count
//   node tools/check-internals.mjs --update --allow-raise
//                                                  also accept increases (a new
//                                                  or moved file); the diff of
//                                                  internals-baseline.json is
//                                                  what the owner approves
//
// A count below its baseline also fails the check: run --update so the gain is
// locked in.

import ts from "typescript";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/e2e-bucketing-scan.mjs";

export const BASELINE_PATH = "tools/internals-baseline.json";

const ROOTS = ["packages/", "tests/", "examples/", "apps/"];
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SRC = "packages/rangojs-router/src/";

export const RULE_OBJECT_CREATE = "request-context-object-create";
export const RULE_VI_MOCK = "internal-vi-mock";
export const RULE_RSC_LITERAL = "rsc-param-literal";
export const RULE_BROWSER_IMPORT = "browser-import-into-server";
export const RULES = [
  RULE_OBJECT_CREATE,
  RULE_VI_MOCK,
  RULE_RSC_LITERAL,
  RULE_BROWSER_IMPORT,
];

/** The one file allowed to derive a request context (plan S5). */
const RENDER_PASS_FILE = `${SRC}server/render-pass.ts`;
/** The one file allowed to own the `_rsc_*` parameter names (plan S16). */
const WIRE_PARAMS_FILE = `${SRC}wire-params.ts`;

/** Directories whose files must not import browser/ at runtime. */
const SERVER_DIRS = ["server/", "rsc/", "router/", "cache/"].map(
  (d) => SRC + d,
);
const BROWSER_DIR = `${SRC}browser/`;
/**
 * L0 helpers that live in browser/ and are imported across sides (rango-d194
 * section 2). They stay where they are and are listed by path, extension
 * stripped.
 */
const BROWSER_L0 = new Set([
  `${SRC}browser/intercept-utils`,
  `${SRC}browser/cookie-name`,
  `${SRC}browser/react/filter-segment-order`,
]);

const REQUEST_CONTEXT_TYPE = /(?:^|[^A-Za-z0-9_$])RequestContext\b/;
const REQUEST_CONTEXT_FACTORIES = new Set([
  "getRequestContext",
  "_getRequestContext",
  "createRequestContext",
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

function inSource(relPath) {
  return relPath.startsWith(SRC) && !isTestFile(relPath);
}

// ---- rule 1 ----------------------------------------------------------------

function typeNodeIsRequestContext(typeNode) {
  return (
    typeNode !== undefined && REQUEST_CONTEXT_TYPE.test(typeNode.getText())
  );
}

function initializerIsRequestContext(init) {
  if (!init) return false;
  const e = skipWrappers(init);
  if (ts.isAsExpression(init) && typeNodeIsRequestContext(init.type)) {
    return true;
  }
  if (!ts.isCallExpression(e)) return false;
  const callee = skipWrappers(e.expression);
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  return name !== undefined && REQUEST_CONTEXT_FACTORIES.has(name);
}

function declaresName(decl, name) {
  return ts.isIdentifier(decl.name) && decl.name.text === name;
}

/**
 * True when `name`, referenced at `use`, resolves syntactically to a parameter
 * or variable typed RequestContext. Walks enclosing scopes outward and takes
 * the nearest declaration of the name.
 */
function identifierIsRequestContext(use, name) {
  for (let scope = use.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const param = scope.parameters.find((p) => declaresName(p, name));
      if (param) {
        return (
          typeNodeIsRequestContext(param.type) ||
          initializerIsRequestContext(param.initializer)
        );
      }
    }
    if (
      ts.isBlock(scope) ||
      ts.isSourceFile(scope) ||
      ts.isModuleBlock(scope) ||
      ts.isCaseClause(scope) ||
      ts.isDefaultClause(scope)
    ) {
      for (const stmt of scope.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (!declaresName(decl, name)) continue;
          return (
            typeNodeIsRequestContext(decl.type) ||
            initializerIsRequestContext(decl.initializer)
          );
        }
      }
    }
  }
  return false;
}

/** True when the call is the (wrapped) initializer of a declaration typed RequestContext. */
function resultIsTypedRequestContext(call) {
  let cur = call;
  for (;;) {
    const p = cur.parent;
    if (!p) return false;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p)
    ) {
      cur = p;
    } else if (ts.isAsExpression(p) || ts.isTypeAssertionExpression(p)) {
      if (typeNodeIsRequestContext(p.type)) return true;
      cur = p;
    } else if (
      ts.isCallExpression(p) &&
      p.arguments.includes(cur) &&
      ts.isPropertyAccessExpression(p.expression) &&
      p.expression.name.text === "assign"
    ) {
      // Object.assign(Object.create(x), {...}) returns its first argument.
      if (p.arguments[0] !== cur) return false;
      cur = p;
    } else if (ts.isVariableDeclaration(p) && p.initializer === cur) {
      return typeNodeIsRequestContext(p.type);
    } else {
      return false;
    }
  }
}

function isObjectCreate(call) {
  const callee = skipWrappers(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "create" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object"
  );
}

function objectCreateOfRequestContext(call) {
  if (!isObjectCreate(call) || call.arguments.length === 0) return false;
  const arg = skipWrappers(call.arguments[0]);
  if (arg.kind === ts.SyntaxKind.NullKeyword) return false;
  if (resultIsTypedRequestContext(call)) return true;
  if (
    ts.isAsExpression(call.arguments[0]) &&
    typeNodeIsRequestContext(call.arguments[0].type)
  ) {
    return true;
  }
  return ts.isIdentifier(arg) && identifierIsRequestContext(call, arg.text);
}

// ---- rule 2 ----------------------------------------------------------------

function isViMock(call) {
  const callee = skipWrappers(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "mock" || callee.name.text === "doMock") &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "vi"
  );
}

// ---- rule 4 ----------------------------------------------------------------

function resolveRelative(importerPath, specifier) {
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerPath), specifier),
  );
  return resolved.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

/** The L0 allowlist matches a file; a bare directory import has no extension to strip. */
function isBrowserRuntimeTarget(importerPath, specifier) {
  if (!specifier.startsWith(".")) return false;
  const target = resolveRelative(importerPath, specifier);
  if (!`${target}/`.startsWith(BROWSER_DIR)) return false;
  return !BROWSER_L0.has(target);
}

function isTypeOnlyImport(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const named = clause.namedBindings;
    // import { type A, type B } from ... loads nothing under verbatim syntax
    // only when there is no default and every named element is type-only; the
    // bundler still keeps a bare `import {} from`, so a fully type-only list
    // is treated as type-only here.
    return (
      !clause.name &&
      named !== undefined &&
      ts.isNamedImports(named) &&
      named.elements.length > 0 &&
      named.elements.every((el) => el.isTypeOnly)
    );
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const clause = node.exportClause;
    return (
      clause !== undefined &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((el) => el.isTypeOnly)
    );
  }
  return false;
}

// ---- scan ------------------------------------------------------------------

/** All four rules over one source text. Hits carry file, line, rule, message. */
export function scanSource(relPath, text) {
  const hits = [];
  const wantObjectCreate =
    relPath.startsWith(SRC) && relPath !== RENDER_PASS_FILE;
  const wantViMock = ROOTS.some((r) => relPath.startsWith(r));
  const wantLiteral = inSource(relPath) && relPath !== WIRE_PARAMS_FILE;
  const wantBrowserImport =
    inSource(relPath) && SERVER_DIRS.some((d) => relPath.startsWith(d));
  if (!wantObjectCreate && !wantViMock && !wantLiteral && !wantBrowserImport) {
    return hits;
  }

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
    if (isBrowserRuntimeTarget(relPath, specifier)) {
      push(
        node,
        RULE_BROWSER_IMPORT,
        `${how} of "${specifier}" pulls browser/ into ${path.posix.dirname(relPath).slice(SRC.length).split("/")[0]}/ at runtime`,
      );
    }
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (wantObjectCreate && objectCreateOfRequestContext(node)) {
        push(
          node,
          RULE_OBJECT_CREATE,
          `${node.getText().split("\n")[0].slice(0, 60)} derives a request context outside server/render-pass.ts`,
        );
      }
      const first = node.arguments[0];
      if (
        wantViMock &&
        isViMock(node) &&
        isStringLike(first) &&
        first.text.startsWith(".")
      ) {
        push(
          node,
          RULE_VI_MOCK,
          `${skipWrappers(node.expression).getText()} of internal module "${first.text}"`,
        );
      }
      if (wantBrowserImport && isStringLike(first)) {
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
      wantBrowserImport &&
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      isStringLike(node.moduleSpecifier) &&
      !isTypeOnlyImport(node)
    ) {
      browserImport(
        node,
        node.moduleSpecifier.text,
        ts.isImportDeclaration(node) ? "import" : "export-from",
      );
    } else if (
      wantBrowserImport &&
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

    if (wantLiteral) {
      const literal =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node)
          ? node.text
          : undefined;
      // An import/export specifier is a module path, not a wire parameter name.
      if (
        literal !== undefined &&
        literal.startsWith("_rsc_") &&
        !ts.isImportDeclaration(node.parent) &&
        !ts.isExportDeclaration(node.parent)
      ) {
        push(
          node,
          RULE_RSC_LITERAL,
          `string literal "${literal.slice(0, 40)}"`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Per-rule, per-file counts: { rule: { file: n } }, files sorted, zeros omitted. */
export function countHits(hits) {
  const counts = Object.fromEntries(RULES.map((r) => [r, {}]));
  for (const h of hits) {
    counts[h.rule][h.file] = (counts[h.rule][h.file] ?? 0) + 1;
  }
  for (const rule of RULES) {
    counts[rule] = Object.fromEntries(
      Object.entries(counts[rule]).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return counts;
}

/**
 * Compare current counts to a baseline ({ rules: { rule: { file: n } } }).
 * `increases`: count above baseline (a missing baseline entry is 0).
 * `decreases`: count below baseline (the baseline is stale).
 */
export function compareToBaseline(baseline, counts) {
  const increases = [];
  const decreases = [];
  for (const rule of RULES) {
    const base = baseline?.rules?.[rule] ?? {};
    const cur = counts[rule] ?? {};
    for (const file of new Set([...Object.keys(base), ...Object.keys(cur)])) {
      const was = base[file] ?? 0;
      const now = cur[file] ?? 0;
      if (now > was) increases.push({ rule, file, was, now });
      else if (now < was) decreases.push({ rule, file, was, now });
    }
  }
  const order = (a, b) =>
    a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file);
  increases.sort(order);
  decreases.sort(order);
  return { increases, decreases };
}

/**
 * The baseline to write: current counts, refusing to raise any count unless
 * `allowRaise`. Returns { baseline, refused } where `refused` lists increases.
 */
export function nextBaseline(baseline, counts, allowRaise) {
  const { increases } = compareToBaseline(baseline, counts);
  if (increases.length > 0 && !allowRaise) {
    return { baseline: undefined, refused: increases };
  }
  return { baseline: { version: 1, rules: counts }, refused: [] };
}

function listFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");
  return out
    .split("\0")
    .filter(Boolean)
    .filter(
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

function readBaseline() {
  const abs = path.join(REPO_ROOT, BASELINE_PATH);
  if (!existsSync(abs)) return undefined;
  return JSON.parse(readFileSync(abs, "utf8"));
}

function serialize(baseline) {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

function describe(d) {
  return `${d.rule}  ${d.file}  baseline ${d.was}, now ${d.now}`;
}

function main(argv) {
  const update = argv.includes("--update");
  const allowRaise = argv.includes("--allow-raise");
  const { hits, scanned } = scanRepo();
  const counts = countHits(hits);
  const baseline = readBaseline();

  if (update) {
    const next = nextBaseline(baseline, counts, allowRaise);
    if (!next.baseline) {
      for (const d of next.refused) console.log(describe(d));
      console.log(
        "check-internals: --update refused to raise the counts above. Fix the code, or pass --allow-raise and have the owner approve the baseline diff.",
      );
      process.exit(1);
    }
    writeFileSync(
      path.join(REPO_ROOT, BASELINE_PATH),
      serialize(next.baseline),
    );
    console.log(`check-internals: wrote ${BASELINE_PATH} (${scanned} files)`);
    return;
  }

  if (!baseline) {
    console.log(
      `check-internals: FAILED. ${BASELINE_PATH} is missing; run with --update --allow-raise to create it.`,
    );
    process.exit(1);
  }
  const { increases, decreases } = compareToBaseline(baseline, counts);
  for (const d of increases) {
    console.log(describe(d));
    for (const h of hits) {
      if (h.rule === d.rule && h.file === d.file) {
        console.log(`  ${h.file}:${h.line}  ${h.message}`);
      }
    }
  }
  if (increases.length > 0) {
    console.log(
      `check-internals: FAILED (${increases.length} count(s) above baseline). New work uses the landed seam (deriveRenderPass, ResolutionPass, readRecord, wire-params.ts, the test kit); see tools/check-internals.mjs for the rules. A deliberate increase is a baseline diff the owner approves: node tools/check-internals.mjs --update --allow-raise.`,
    );
    process.exit(1);
  }
  if (decreases.length > 0) {
    for (const d of decreases) console.log(describe(d));
    console.log(
      `check-internals: FAILED (${decreases.length} count(s) below baseline, the baseline is stale). Run: node tools/check-internals.mjs --update`,
    );
    process.exit(1);
  }
  console.log(`check-internals: OK (${scanned} files scanned)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
