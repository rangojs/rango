#!/usr/bin/env node
// Console guard baseline check.
//
// The console guard (tests/shared-e2e/src/console-guard.ts) fails a dev e2e
// test that prints a denied message, unless the test declares it
// (expectConsole) or tools/e2e-console-baseline.json lists it. The baseline is
// debt with a reason per entry, and this check keeps it from rotting:
//
// Default (CI lint, no e2e run needed): every entry has an app, a test, a
// rule on the deny list and a non-empty reason; no entry is listed twice; the
// test still exists (its file, and its title in that file or in a shared
// body under tests/shared-e2e/src, literally or as the literal parts of a
// template-literal title, which cannot check the placeholders' values). An
// entry whose test runs and no longer prints the message is caught by the
// guard itself, which fails that test.
//
// --from <dir> (repeatable): compare with a recorded run
// (RANGO_CONSOLE_GUARD=record RANGO_CONSOLE_GUARD_DIR=<dir> playwright test
// --project=dev). Lists denied messages no entry covers and entries whose
// test passed without printing the message; exits 1 on either.
//
// --from <dir> --write: rewrite the baseline from those runs. Entries that
// stay keep their reason; a new entry gets an empty one, and this check fails
// until someone writes it. A message seen in only some of the runs is marked
// intermittent.
//
// Run: node tools/check-e2e-console-baseline.mjs
//      node tools/check-e2e-console-baseline.mjs --from <dir> [--from <dir>] [--write]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BASELINE_PATH = path.join(REPO_ROOT, "tools/e2e-console-baseline.json");
const GUARD_PATH = path.join(
  REPO_ROOT,
  "tests/shared-e2e/src/console-guard.ts",
);
const SHARED_DIR = path.join(REPO_ROOT, "tests/shared-e2e/src");

/** The e2e directory of each app the guard is installed in. */
const APP_DIRS = {
  "rangojs-router": "packages/rangojs-router/e2e",
  "cloudflare-basic": "tests/cloudflare-basic/e2e",
};

/**
 * @typedef {{ app: string, test: string, rule: string, reason: string, intermittent?: boolean }} Entry
 */

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const fromDirs = args.flatMap((arg, i) =>
  arg === "--from" ? [args[i + 1]] : [],
);

function fail(lines) {
  console.error(`Console baseline check: ${lines.length} problem(s).\n`);
  for (const line of lines) console.error(`  - ${line}`);
  process.exit(1);
}

/** @returns {Entry[]} */
function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return [];
  const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (!raw || !Array.isArray(raw.entries)) {
    fail([
      `${path.relative(REPO_ROOT, BASELINE_PATH)} must be { "entries": [...] }`,
    ]);
  }
  return raw.entries;
}

function denyRuleIds() {
  const source = readFileSync(GUARD_PATH, "utf8");
  const start = source.indexOf("CONSOLE_DENY_RULES");
  const end = source.indexOf("];", start);
  return new Set(
    [...source.slice(start, end).matchAll(/\bid:\s*"([^"]+)"/g)].map(
      (m) => m[1],
    ),
  );
}

const keyOf = (entry) => `${entry.app}|${entry.test}|${entry.rule}`;

// A title built in a template literal (`${scenario}: after ${entry}, ...`)
// matches when its literal parts appear in order around the placeholders.
function templateMatchers(source) {
  const matchers = [];
  for (const [, body] of source.matchAll(
    /`((?:[^`\\]|\\.)*\$\{(?:[^`\\]|\\.)*)`/g,
  )) {
    const parts = body.split(/\$\{[^}]*\}/);
    if (parts.join("").trim().length < 20) continue;
    const escaped = parts.map((part) =>
      part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    matchers.push(new RegExp(`^${escaped.join(".+")}$`));
  }
  return matchers;
}

function titleIn(sources, title) {
  return sources.some(
    (source) =>
      source.includes(title) ||
      templateMatchers(source).some((matcher) => matcher.test(title)),
  );
}

function checkStatic(entries) {
  const problems = [];
  const rules = denyRuleIds();
  const shared = readdirSync(SHARED_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(path.join(SHARED_DIR, name), "utf8"));
  const seen = new Set();
  for (const entry of entries) {
    const label = `[${entry?.rule}] ${entry?.app} > ${entry?.test}`;
    if (
      !entry ||
      typeof entry.app !== "string" ||
      typeof entry.test !== "string" ||
      typeof entry.rule !== "string"
    ) {
      problems.push(
        `an entry needs string fields { app, test, rule, reason }: ${JSON.stringify(entry)}`,
      );
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      problems.push(`no reason: ${label}`);
    }
    if (seen.has(keyOf(entry))) problems.push(`listed twice: ${label}`);
    seen.add(keyOf(entry));
    if (!rules.has(entry.rule)) {
      problems.push(
        `rule is not on the deny list (console-guard.ts): ${label}`,
      );
    }
    const appDir = APP_DIRS[entry.app];
    if (!appDir) {
      problems.push(`unknown app "${entry.app}": ${label}`);
      continue;
    }
    const segments = entry.test.split(" > ");
    const file = path.join(REPO_ROOT, appDir, segments[0]);
    if (!existsSync(file)) {
      problems.push(`the test file is gone, remove the entry: ${label}`);
      continue;
    }
    const title = segments[segments.length - 1];
    const sources = [readFileSync(file, "utf8"), ...shared];
    if (!titleIn(sources, title)) {
      problems.push(
        `no test with this title any more, remove or rename the entry: ${label}`,
      );
    }
  }
  return problems;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** What each recorded run saw: the denied (app, test, rule) keys and the tests that passed. */
function readRuns(dirs) {
  return dirs.map((dir) => {
    const denied = new Map();
    for (const message of readJsonl(path.join(dir, "messages.jsonl"))) {
      if (message.project !== "dev" || !message.rule) continue;
      if (message.disposition === "allowed") continue;
      // An expected failure (test.fail) is tracked by its own table.
      if (message.status !== "passed") continue;
      const entry = {
        app: message.app,
        test: message.test,
        rule: message.rule,
      };
      denied.set(keyOf(entry), entry);
    }
    const passed = new Set();
    for (const result of readJsonl(path.join(dir, "tests.jsonl"))) {
      if (result.project === "dev" && result.status === "passed") {
        passed.add(`${result.app}|${result.test}`);
      }
    }
    return { dir, denied, passed };
  });
}

function compareWithRuns(entries, runs) {
  const problems = [];
  const listed = new Map(entries.map((entry) => [keyOf(entry), entry]));
  const reported = new Set();
  for (const run of runs) {
    for (const [key, entry] of run.denied) {
      if (listed.has(key) || reported.has(key)) continue;
      reported.add(key);
      problems.push(
        `not in the baseline: [${entry.rule}] ${entry.app} > ${entry.test}`,
      );
    }
  }
  for (const entry of entries) {
    if (entry.intermittent) continue;
    const test = `${entry.app}|${entry.test}`;
    const quiet = runs.filter(
      (run) => run.passed.has(test) && !run.denied.has(keyOf(entry)),
    );
    if (quiet.length > 0) {
      problems.push(
        `passed without the message in ${quiet.length} of ${runs.length} run(s), remove the entry or mark it intermittent: [${entry.rule}] ${entry.app} > ${entry.test}`,
      );
    }
  }
  return problems;
}

function rewrite(entries, runs) {
  const previous = new Map(entries.map((entry) => [keyOf(entry), entry]));
  const next = new Map();
  for (const run of runs) {
    for (const [key, seen] of run.denied) {
      if (next.has(key)) continue;
      const test = `${seen.app}|${seen.test}`;
      // Seen here, and absent from another run in which the test passed.
      const intermittent = runs.some(
        (other) => other.passed.has(test) && !other.denied.has(key),
      );
      const kept = previous.get(key);
      next.set(key, {
        app: seen.app,
        test: seen.test,
        rule: seen.rule,
        reason: kept?.reason ?? "",
        ...(intermittent || kept?.intermittent ? { intermittent: true } : {}),
      });
    }
  }
  const sorted = [...next.values()].sort((a, b) =>
    keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
  );
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ entries: sorted }, null, 2) + "\n",
  );
  return sorted;
}

let entries = loadBaseline();
const problems = [];
if (fromDirs.length > 0) {
  const runs = readRuns(fromDirs);
  if (WRITE) {
    entries = rewrite(entries, runs);
    console.log(
      `Console baseline: wrote ${entries.length} entr${entries.length === 1 ? "y" : "ies"} from ${runs.length} run(s).`,
    );
  } else {
    problems.push(...compareWithRuns(entries, runs));
  }
}
problems.push(...checkStatic(entries));
if (problems.length > 0) fail(problems);

const byRule = new Map();
for (const entry of entries)
  byRule.set(entry.rule, (byRule.get(entry.rule) ?? 0) + 1);
console.log(
  `Console baseline: OK — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, each with a reason` +
    (entries.length > 0
      ? ` (${[...byRule].map(([rule, count]) => `${rule} ${count}`).join(", ")}).`
      : "."),
);
