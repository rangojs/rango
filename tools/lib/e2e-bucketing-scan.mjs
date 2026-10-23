// Shared scanning for the e2e dev/prod bucketing tools (guard + parity report).
//
// Discovers the test suites that use a title-based dev/production split (a
// Playwright `production` project whose grep references "(production"), and
// parses their test files into a flat list of describe blocks, each classified
// by the fixture it wires (build / dev / indeterminate) and whether its full
// nested title is matched by THAT suite's actual production grep.

import ts from "typescript";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

function parse(file, text = readFileSync(file, "utf8")) {
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

const lineOf = (sf, node) =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

// The text of a string or no-substitution template literal, else undefined.
const literalText = (arg) =>
  arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
    ? arg.text
    : undefined;

const isFunctionLike = (node) =>
  !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

// Title of a describe call (string/no-substitution-template literal), "" for a
// dynamic title, or null when the node is not a describe call.
function describeTitle(node) {
  if (!ts.isCallExpression(node) || !isDescribeCallee(node.expression))
    return null;
  return literalText(node.arguments[0]) ?? ""; // "" = dynamic title
}

// Title helpers. `helper("name", body, options)` registers `body` once per
// entry, in a describe titled `${name} ${tag}` on a fixture of that mode. The
// scanner expands each call the same way, and helperDefinitionViolations()
// holds the definition a test file imports to this table.
//   prodDescribe: tests/vite-rsc-demo/e2e/helper.ts
//   bothModes:    e2e/fixture.ts in rangojs-router and cloudflare-basic
const TITLE_HELPERS = {
  prodDescribe: [["build", "(production)"]],
  bothModes: [
    ["dev", "(dev)"],
    ["build", "(production)"],
  ],
};
const HELPER_BODY_ARG = 1;

const isTitleHelper = (name) => Object.hasOwn(TITLE_HELPERS, name);

// The helper a call invokes by its bare name, or null.
function helperCall(node) {
  return ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    isTitleHelper(node.expression.text)
    ? node.expression.text
    : null;
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

// Module-scope functions by name: `function x() {}` and `const x = () => {}`.
function moduleFunctions(sourceFile) {
  const fns = new Map();
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      fns.set(stmt.name.text, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && isFunctionLike(decl.initializer)) {
          fns.set(decl.name.text, decl.initializer);
        }
      }
    }
  }
  return fns;
}

// The fixture modes wired in a describe's OWN body: nested describes and
// helper calls are classified on their own.
function classifyBody(bodyNode, fixtureVars) {
  let build = false;
  let dev = false;
  let indeterminate = false;
  const visit = (n) => {
    if (describeTitle(n) !== null || helperCall(n) !== null) return;
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
}

// Parse one test file against a suite's production grep. Returns a flat list of
// describe records: { title, fullPath, line, build, dev, indeterminate, taggedProd }.
// build/dev/indeterminate reflect the fixture wired in the describe's OWN body
// (nested describes are recorded separately); a describe without one inside a
// title-helper expansion takes the expansion's mode. taggedProd is whether the
// suite's real production grep matches the full nested title path. Records from
// a title helper carry `via` (the helper's name); a call the scanner cannot
// expand yields one record with a `problem` instead.
export function scanFile(file, prodGrep) {
  return scanSource(file, readFileSync(file, "utf8"), prodGrep);
}

// scanFile over source text (tests pass fixtures without touching disk).
export function scanSource(file, text, prodGrep) {
  const sf = parse(file, text);
  const fixtureVars = moduleFixtureVars(sf);
  const functions = moduleFunctions(sf);
  const stack = [];
  const records = [];
  // The mode a describe with no fixture of its own runs on: set inside a
  // title-helper expansion, where the helper wires the fixture.
  let inherited = null;
  const expanding = new Set(); // named suites on the stack (no recursion)

  const push = (title, node, fixture, extra) => {
    const fullPath = [...stack, title].join(" > ");
    records.push({
      title,
      fullPath,
      line: lineOf(sf, node),
      build: false,
      dev: false,
      indeterminate: false,
      ...fixture,
      taggedProd: prodGrep.test(fullPath),
      ...extra,
    });
  };
  const problem = (helper, node, text) =>
    push(
      `${helper}(...)`,
      node,
      {},
      { taggedProd: false, via: helper, problem: text },
    );

  // Visit `node` under `title`, with `mode` as the inherited fixture mode.
  const within = (title, mode, node, named) => {
    const outer = inherited;
    stack.push(title);
    inherited = mode;
    if (named) expanding.add(named);
    visit(node);
    if (named) expanding.delete(named);
    inherited = outer;
    stack.pop();
  };

  const visit = (node) => {
    // An alias or a namespace call hides a helper call from the expansion.
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (isTitleHelper(imported) && node.name.text !== imported) {
        problem(
          imported,
          node,
          `import ${imported} without an alias: the guard expands calls by name`,
        );
      }
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isTitleHelper(node.expression.name.text)
    ) {
      const helper = node.expression.name.text;
      problem(
        helper,
        node,
        `call ${helper} by its bare name: the guard expands calls by name`,
      );
      return;
    }

    const helper = helperCall(node);
    if (helper !== null) {
      const modes = TITLE_HELPERS[helper];
      const name = literalText(node.arguments[0]);
      if (name === undefined && modes.some(([mode]) => mode === "dev")) {
        problem(
          helper,
          node,
          `${helper} needs a string-literal name: a computed one can put "(production)" in the dev describe's title`,
        );
        return;
      }
      const suite = node.arguments[HELPER_BODY_ARG];
      const named = suite && ts.isIdentifier(suite) ? suite.text : undefined;
      const fn = isFunctionLike(suite)
        ? suite
        : named && !expanding.has(named)
          ? functions.get(named)
          : undefined;
      for (const [mode, tag] of modes) {
        const title = name ? `${name} ${tag}` : tag;
        push(title, node, { [mode]: true }, { via: helper });
        if (fn?.body) within(title, mode, fn.body, named);
      }
      return;
    }

    const title = describeTitle(node);
    if (title !== null) {
      const fn = node.arguments[1];
      if (isFunctionLike(fn)) {
        let { build, dev, indeterminate } = classifyBody(fn.body, fixtureVars);
        // Module-scope fixtures (const f = useFixture(...)) are often used only
        // via helpers (shopUrl → f.url). A top-level describe that never names
        // `f` would otherwise look fixture-less and skip the parity gate.
        // Inherit module mode for top-level describes with no own fixture.
        if (!build && !dev && !indeterminate && stack.length === 0) {
          if (fixtureVars.dev.size > 0) dev = true;
          if (fixtureVars.build.size > 0) build = true;
        }
        const own = build || dev || indeterminate;
        const ownMode = build === dev ? null : build ? "build" : "dev";
        if (!own && inherited) {
          build = inherited === "build";
          dev = inherited === "dev";
        }
        push(title, node, { build, dev, indeterminate });
        within(title, own ? inherited && ownMode : inherited, fn.body);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return records;
}

// Bucketing violations in one file's records: a build fixture outside the
// production bucket, a dev fixture inside it, or a helper call the scanner
// cannot expand. Returns [{ line, title, kind: "build" | "dev" | "helper", problem? }].
export function bucketingViolations(records) {
  const out = [];
  for (const d of records) {
    const at = { line: d.line, title: d.fullPath };
    if (d.problem) out.push({ ...at, kind: "helper", problem: d.problem });
    if (d.build && !d.taggedProd) out.push({ ...at, kind: "build" });
    if (d.dev && d.taggedProd) out.push({ ...at, kind: "dev" });
  }
  return out;
}

// The literal after `${name}` in the template `${name}<suffix>`, else null.
function templateSuffix(arg, name) {
  if (
    !arg ||
    !ts.isTemplateExpression(arg) ||
    arg.head.text !== "" ||
    arg.templateSpans.length !== 1
  ) {
    return null;
  }
  const [span] = arg.templateSpans;
  return ts.isIdentifier(span.expression) && span.expression.text === name
    ? span.literal.text
    : null;
}

function callsIdentifier(node, name) {
  let found = false;
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === name
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  if (node) visit(node);
  return found;
}

// Checks each definition of `helper` in a module against its TITLE_HELPERS
// entry: one describe per entry titled `${name} ${tag}`, each wiring only a
// literal fixture of that mode and calling the body parameter.
// Returns { count, problems: [{ line, problem }] }.
export function helperDefinitions(file, text, helper) {
  const sf = parse(file, text);
  const fixtureVars = moduleFixtureVars(sf);
  const modes = TITLE_HELPERS[helper];
  const out = { count: 0, problems: [] };
  const report = (n, problem) =>
    out.problems.push({ line: lineOf(sf, n), problem });

  const check = (fn) => {
    out.count++;
    const [nameParam, bodyParam] = [
      fn.parameters[0],
      fn.parameters[HELPER_BODY_ARG],
    ];
    if (
      !nameParam ||
      !ts.isIdentifier(nameParam.name) ||
      !bodyParam ||
      !ts.isIdentifier(bodyParam.name)
    ) {
      report(fn, `${helper} must take (name, body, ...) as plain parameters`);
      return;
    }
    const name = nameParam.name.text;
    const body = bodyParam.name.text;
    const seen = new Map();
    const visit = (n) => {
      if (describeTitle(n) === null) {
        ts.forEachChild(n, visit);
        return;
      }
      const suffix = templateSuffix(n.arguments[0], name);
      const entry = modes.find(([, tag]) => suffix === ` ${tag}`);
      if (!entry) {
        const titles = modes.map(([, tag]) => `\`\${${name}} ${tag}\``);
        report(n, `a ${helper} describe title must be ${titles.join(" or ")}`);
        return;
      }
      const [mode, tag] = entry;
      seen.set(tag, (seen.get(tag) ?? 0) + 1);
      const fnArg = n.arguments[1];
      const wired = isFunctionLike(fnArg)
        ? classifyBody(fnArg.body, fixtureVars)
        : {};
      if (
        wired.build !== (mode === "build") ||
        wired.dev !== (mode === "dev") ||
        wired.indeterminate
      ) {
        report(
          n,
          `the ${tag} describe must wire useFixture({ mode: "${mode}" }) and no other mode`,
        );
      }
      if (!callsIdentifier(fnArg, body)) {
        report(n, `the ${tag} describe must call ${body}(...)`);
      }
    };
    if (fn.body) ts.forEachChild(fn.body, visit);
    for (const [, tag] of modes) {
      if (seen.get(tag) !== 1) {
        report(fn, `${helper} must register exactly one ${tag} describe`);
      }
    }
  };

  const fn = moduleFunctions(sf).get(helper);
  if (fn) check(fn);
  return out;
}

// A relative import specifier resolved to a source file, or undefined.
function resolveModule(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.js`,
    base.replace(/\.js$/, ".ts"),
    path.join(base, "index.ts"),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

// Checks the definition of each helper a test file calls: its own, or the one
// in the relative module it imports the helper from. `cache` (keyed by module
// and helper) checks a shared definition once per run.
// Returns [{ file, line, title, kind: "helper", problem }].
export function helperDefinitionViolations(file, helpers, cache = new Map()) {
  const text = readFileSync(file, "utf8");
  const sf = parse(file, text);
  const local = moduleFunctions(sf);
  const out = [];
  for (const helper of helpers) {
    let source = local.has(helper) ? file : undefined;
    let spec;
    for (const stmt of sf.statements) {
      if (source || !ts.isImportDeclaration(stmt)) continue;
      const bindings = stmt.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      if (
        bindings.elements.some(
          (e) => (e.propertyName ?? e.name).text === helper,
        )
      ) {
        spec = stmt.moduleSpecifier.text;
        source = spec.startsWith(".") ? resolveModule(file, spec) : undefined;
      }
    }
    const fail = (line, problem) =>
      out.push({
        file,
        line,
        title: `${helper} definition`,
        kind: "helper",
        problem,
      });
    if (!source) {
      fail(
        0,
        spec
          ? `${helper} is imported from "${spec}", which the guard cannot read; import it from a relative module`
          : `${helper} is called but neither defined nor imported here`,
      );
      continue;
    }
    const key = `${source}#${helper}`;
    const seen = cache.get(key);
    const { count, problems } =
      seen ?? helperDefinitions(source, readFileSync(source, "utf8"), helper);
    cache.set(key, { count, problems });
    if (count === 0) {
      fail(0, `${path.basename(source)} does not define ${helper}`);
    }
    // A shared definition's problems are reported once, by its first caller.
    if (seen) continue;
    for (const p of problems) {
      out.push({
        file: source,
        line: p.line,
        title: `${helper} definition`,
        kind: "helper",
        problem: p.problem,
      });
    }
  }
  return out;
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
