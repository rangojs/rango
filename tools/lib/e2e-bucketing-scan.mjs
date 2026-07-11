// Shared scanning for the e2e dev/prod bucketing tools (guard + parity report).
//
// Discovers the test suites that use a title-based dev/production split (a
// Playwright `production` project whose grep references "(production"), and
// parses their test files into a flat list of describe blocks, each classified
// by the fixture it wires (build / dev / indeterminate) and whether its full
// nested title is matched by THAT suite's actual production grep.

import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// describe modifiers that still take (title, fn): test.describe.serial(...), etc.
// NOT ".configure" — that takes an options object, not a describe body.
const DESCRIBE_MODIFIERS = new Set([
  "serial",
  "only",
  "skip",
  "fixme",
  "parallel",
]);

export function walk(dir, test, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, test, out);
    else if (test(full)) out.push(full);
  }
  return out;
}

export function isTestFile(p) {
  return /\.test\.(t|j)sx?$/.test(p);
}

function scriptKindFor(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(file) {
  const text = readFileSync(file, "utf8");
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
}

// Pull the production project's grep regex out of a playwright config. The
// production grep is the one that references "(production" and is NOT the dev
// project's negative lookahead (which also mentions it). Returns a real RegExp
// so callers match titles with the exact semantics Playwright uses, or null.
function extractProdGrep(configText) {
  const matches = configText.matchAll(/grep:\s*\/((?:[^/\\\n]|\\.)*)\//g);
  for (const m of matches) {
    const pattern = m[1];
    if (pattern.includes("production") && !pattern.includes("?!")) {
      try {
        return new RegExp(pattern);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Suites whose playwright config declares a production project.
// Returns [{ dir, testDir, prodGrep }].
export function splitSuites() {
  const configs = walk(REPO_ROOT, (f) => /playwright\.config\.(t|j)s$/.test(f));
  const suites = [];
  for (const cfg of configs) {
    const text = readFileSync(cfg, "utf8");
    const prodGrep = extractProdGrep(text);
    if (!prodGrep) continue;
    const m = text.match(/testDir:\s*["'`]([^"'`]+)["'`]/);
    suites.push({
      dir: path.dirname(cfg),
      testDir: m ? m[1] : "e2e",
      prodGrep,
    });
  }
  return suites;
}

function nameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

// `X.describe(...)`, `X.describe.serial(...)`, `.only`, `.skip`, `.fixme`,
// `.parallel` — but not `X.describe.configure(...)`.
function isDescribeCallee(expr) {
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (expr.name.text === "describe") return true;
  return (
    DESCRIBE_MODIFIERS.has(expr.name.text) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "describe"
  );
}

// Title of a describe call (string/no-substitution-template literal), "" for a
// dynamic title, or null when the node is not a describe call.
function describeTitle(node) {
  if (!ts.isCallExpression(node) || !isDescribeCallee(node.expression))
    return null;
  const arg = node.arguments[0];
  if (
    arg &&
    (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
  ) {
    return arg.text;
  }
  return ""; // dynamic (template / variable) title
}

// Name passed to the prodDescribe("name", body) helper, which wraps a build
// fixture and appends a "(production)" title. Returns the name, "" for a dynamic
// name, or null when the node is not a prodDescribe call.
function prodDescribeName(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== "prodDescribe"
  ) {
    return null;
  }
  const arg = node.arguments[0];
  if (
    arg &&
    (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
  ) {
    return arg.text;
  }
  return "";
}

// "build" | "dev" | "indeterminate" | null for a useFixture({ mode }) call.
function useFixtureMode(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== "useFixture"
  ) {
    return null;
  }
  const arg = node.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const p of arg.properties) {
    if (ts.isPropertyAssignment(p) && nameText(p.name) === "mode") {
      if (ts.isStringLiteral(p.initializer)) return p.initializer.text;
      return "indeterminate"; // computed/ternary/identifier mode
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === "mode") {
      return "indeterminate"; // `useFixture({ mode })`
    }
  }
  return null;
}

// Module-scope variable names initialized from useFixture({ mode }).
// Build and dev are tracked separately so a describe that only references a
// module-scope `const f = useFixture({ mode: "dev" })` is still classified as
// a fixture-owning describe (parity must see the missing production twin).
function moduleFixtureVars(sourceFile) {
  /** @type {{ build: Set<string>, dev: Set<string> }} */
  const names = { build: new Set(), dev: new Set() };
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
      const mode = useFixtureMode(decl.initializer);
      if (mode === "build") names.build.add(decl.name.text);
      else if (mode === "dev") names.dev.add(decl.name.text);
    }
  }
  return names;
}

// Parse one test file against a suite's production grep. Returns a flat list of
// describe records: { title, fullPath, line, build, dev, indeterminate, taggedProd }.
// build/dev/indeterminate reflect the fixture wired in the describe's OWN body
// (nested describes are recorded separately). taggedProd is whether the suite's
// real production grep matches the full nested title path.
export function scanFile(file, prodGrep) {
  const sf = parse(file);
  const fixtureVars = moduleFixtureVars(sf);
  const stack = [];
  const records = [];

  const classifyOwnBody = (bodyNode) => {
    let build = false;
    let dev = false;
    let indeterminate = false;
    const visit = (n) => {
      // do not descend into nested describes or prodDescribe wrappers
      if (describeTitle(n) !== null || prodDescribeName(n) !== null) return;
      const mode = useFixtureMode(n);
      if (mode === "build") build = true;
      else if (mode === "dev") dev = true;
      else if (mode === "indeterminate") indeterminate = true;
      if (
        ts.isIdentifier(n) &&
        (n.text === "devURL" || n.text === "devServerURL")
      ) {
        dev = true;
      }
      if (ts.isIdentifier(n) && fixtureVars.build.has(n.text)) build = true;
      if (ts.isIdentifier(n) && fixtureVars.dev.has(n.text)) dev = true;
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(bodyNode, visit);
    return { build, dev, indeterminate };
  };

  const visit = (node) => {
    // prodDescribe("name", body) == a top-level production describe (build
    // fixture + "(production)" title) generated inside the helper.
    const prodName = prodDescribeName(node);
    if (prodName !== null) {
      const synthesized =
        prodName === "" ? "(production)" : `${prodName} (production)`;
      stack.push(synthesized);
      const fullPath = stack.join(" > ");
      records.push({
        title: synthesized,
        fullPath,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        build: true,
        dev: false,
        indeterminate: false,
        taggedProd: prodGrep.test(fullPath),
      });
      const body = node.arguments[1];
      if (body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
        ts.forEachChild(body.body, visit);
      }
      stack.pop();
      return;
    }

    const title = describeTitle(node);
    if (title !== null) {
      stack.push(title);
      const fullPath = stack.join(" > ");
      const fn = node.arguments[1];
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        let { build, dev, indeterminate } = classifyOwnBody(fn.body);
        // Module-scope fixtures (const f = useFixture(...)) are often used only
        // via helpers (shopUrl → f.url). A top-level describe that never names
        // `f` would otherwise look fixture-less and skip the parity gate.
        // Inherit module mode for top-level describes with no own fixture.
        if (!build && !dev && !indeterminate && stack.length === 1) {
          if (fixtureVars.dev.size > 0) dev = true;
          if (fixtureVars.build.size > 0) build = true;
        }
        records.push({
          title,
          fullPath,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          build,
          dev,
          indeterminate,
          taggedProd: prodGrep.test(fullPath),
        });
        ts.forEachChild(fn.body, visit);
      }
      stack.pop();
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return records;
}

// Convenience: scan every split suite, yielding { suite, file, records }.
export function scanSplitSuites() {
  const out = [];
  for (const suite of splitSuites()) {
    const root = path.join(suite.dir, suite.testDir);
    for (const file of walk(root, isTestFile)) {
      out.push({ suite, file, records: scanFile(file, suite.prodGrep) });
    }
  }
  return out;
}
