// Guard against a silent docs-rot class in the two claim-bearing positioning
// docs: an API name in README.md or docs/why-rango.md that no longer exists in
// the router source.
//
// Both docs carry an editorial bar (see the HTML comment at the top of
// why-rango.md, registered in AGENTS.md): every claim describes shipped
// behavior with a real-API snippet. A rename like `ctx.rendered()` ->
// something else would silently strand those snippets; this guard fails CI so
// the docs are updated alongside the rename.
//
// What is checked (deliberately API-shaped extraction, to avoid false
// positives on userland snippet helpers like `formatPrice(`):
//   1. Named imports from `@rangojs/router*` inside fenced code blocks.
//   2. `ctx.NAME(` and `path.NAME(` member calls in fenced code blocks.
//   3. Inline-code call references of the exact form `name()` (optionally
//      `ctx.name()` / `path.name()`), e.g. `updateTag()`, `loading()`.
//   4. Inline-code hook/factory names matching use[A-Z]* / create[A-Z]*.
//
// A candidate passes if the bare name still appears in a definition-ish
// position (`name(`, `name:`, `name =`, `name?:`, `name<`, or an export)
// anywhere in packages/rangojs-router/src, with comments stripped and test
// files excluded. This detects deletions and renames, not signature changes.
//
// Run: node tools/check-docs-api.mjs [--list]   (non-zero exit on unknowns)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const DOCS = [
  "packages/rangojs-router/README.md",
  "packages/rangojs-router/docs/why-rango.md",
  // The caching/PPR skill family teaches API surface the same way the
  // positioning docs do, and has drifted the same way: skills taught a
  // "use cache"-only cacheTag() after src shipped the render-callable form
  // (issue #684, plan 003). Guard them with the same identifier check.
  ...[
    "cache-guide",
    "caching",
    "defer-hydration",
    "document-cache",
    "ppr",
    "prerender",
    "shell-manifest",
    "use-cache",
  ].map((skill) => `packages/rangojs-router/skills/${skill}/SKILL.md`),
];

const SRC_ROOT = path.join(REPO_ROOT, "packages/rangojs-router/src");

// Non-API tokens that legitimately appear in an API-shaped position in the
// docs. Extend deliberately; every entry weakens the guard a little.
const ALLOWLIST = new Set([
  // Illustrative userland factory names in the structure-vs-config example
  // ("config extracts into factories you can share").
  "withCaching",
  "withAuth",
  // Suggested userland factory name in the defer-hydration recipe ("factor the
  // module into a createHydrationGate() if you go there") -- deliberately not a
  // shipped API; the recipe has zero API commitment.
  "createHydrationGate",
]);

// --- extraction ------------------------------------------------------------

function extractCandidates(markdown) {
  const candidates = new Map(); // name -> first context line

  const add = (name, context) => {
    if (!name || ALLOWLIST.has(name)) return;
    if (!candidates.has(name)) candidates.set(name, context.trim());
  };

  const fenced = [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(
    (m) => m[1],
  );

  for (const block of fenced) {
    // 1. Named imports from @rangojs/router and its subpaths.
    for (const imp of block.matchAll(
      /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"@rangojs\/router[^"]*"/g,
    )) {
      for (const raw of imp[1].split(",")) {
        const name = raw
          .replace(/\btype\b/, "")
          .trim()
          .split(/\s+as\s+/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(name)) add(name, imp[0]);
      }
    }
    // 2. ctx./path. member calls.
    for (const call of block.matchAll(
      /\b(?:ctx|path)\.([a-zA-Z_$][\w$]*)\(/g,
    )) {
      add(call[1], call[0]);
    }
  }

  // 3 + 4. Inline code spans.
  for (const span of markdown.matchAll(/`([^`\n]+)`/g)) {
    const code = span[1];
    // `name()` / `ctx.name()` / `path.name()` — written as a call, so
    // API-shaped by construction.
    const callForm = code.match(/^(?:ctx\.|path\.)?([a-zA-Z_$][\w$]*)\(\)$/);
    if (callForm) add(callForm[1], code);
    // Bare hook/factory names.
    const hookForm = code.match(/^((?:use|create)[A-Z][\w$]*)$/);
    if (hookForm) add(hookForm[1], code);
  }

  return candidates;
}

// --- verification ----------------------------------------------------------

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function collectSrcCorpus(dir, chunks) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "__mocks__") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSrcCorpus(abs, chunks);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      chunks.push(stripComments(fs.readFileSync(abs, "utf8")));
    }
  }
  return chunks;
}

const corpus = collectSrcCorpus(SRC_ROOT, []).join("\n");

function existsInSrc(name) {
  const escaped = name.replace(/\$/g, "\\$");
  // Second alternation: class declarations (`export class Skip extends Error`)
  // sit in none of the value-ish positions the first pattern matches -- found
  // when the skills joined the doc list and `Skip` false-negatived.
  return (
    new RegExp(`\\b${escaped}\\s*(?:\\(|:|=[^=]|\\?:|<)`).test(corpus) ||
    new RegExp(`\\bclass\\s+${escaped}\\b`).test(corpus)
  );
}

// --- run ---------------------------------------------------------------------

const listMode = process.argv.includes("--list");
const unknown = [];
let total = 0;

for (const docRel of DOCS) {
  const markdown = fs.readFileSync(path.join(REPO_ROOT, docRel), "utf8");
  const candidates = extractCandidates(markdown);
  total += candidates.size;
  for (const [name, context] of candidates) {
    const ok = existsInSrc(name);
    if (listMode) {
      console.log(`${ok ? "ok  " : "MISS"} ${name.padEnd(28)} ${docRel}`);
    }
    if (!ok) unknown.push({ doc: docRel, name, context });
  }
}

if (unknown.length > 0) {
  console.error(
    `Docs API guard: ${unknown.length} identifier(s) referenced in positioning docs but not found in router src:\n`,
  );
  for (const u of unknown) {
    console.error(`  ${u.doc}\n    -> ${u.name}  (from: ${u.context})`);
  }
  console.error(
    "\nEither the API was renamed/removed (update the doc in this PR) or the",
  );
  console.error(
    "extraction caught a non-API token (add it to ALLOWLIST in tools/check-docs-api.mjs).",
  );
  process.exit(1);
}

console.log(`Docs API guard: ${total} identifier(s) verified against src.`);
