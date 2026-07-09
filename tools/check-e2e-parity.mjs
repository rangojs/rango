// Dev/prod parity report: lists top-level describes that run in the dev bucket
// but have no matching (production) sibling, i.e. scenarios covered in dev mode
// but not in a production build. This catches the OTHER failure mode the
// bucketing guard cannot see — a missing production twin (vs. a mislabeled one).
//
// Default (advisory): prints gaps and always exits 0.
// Strict (`--strict` or E2E_PARITY_STRICT=1): exits 1 when any gap is not
// listed in tools/e2e-parity-allowlist.json with a reason. CI uses --strict.
//
// Run: node tools/check-e2e-parity.mjs
//      node tools/check-e2e-parity.mjs --strict

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  isTestFile,
  scanFile,
  splitSuites,
  walk,
} from "./lib/e2e-bucketing-scan.mjs";

const STRICT =
  process.argv.includes("--strict") || process.env.E2E_PARITY_STRICT === "1";

const ALLOWLIST_PATH = path.join(REPO_ROOT, "tools/e2e-parity-allowlist.json");

/**
 * @typedef {{ base: string, file?: string, reason: string }} AllowlistEntry
 */

/** @returns {AllowlistEntry[]} */
function loadAllowlist() {
  try {
    const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
    if (!Array.isArray(raw)) {
      throw new Error("allowlist root must be an array");
    }
    for (const e of raw) {
      if (!e || typeof e.base !== "string" || typeof e.reason !== "string") {
        throw new Error(
          "each allowlist entry needs string fields { base, reason }",
        );
      }
      if (e.reason.trim() === "") {
        throw new Error(
          `allowlist entry for base "${e.base}" needs a non-empty reason`,
        );
      }
    }
    return raw;
  } catch (err) {
    if (STRICT) {
      console.error(
        `Failed to load ${path.relative(REPO_ROOT, ALLOWLIST_PATH)}:`,
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
    return [];
  }
}

// Strip the mode marker so a dev describe and its production twin share a base.
// Handles the marker spellings used across the suites: "(dev)", "(dev mode)",
// "(production)", "(production build)", "(prod)", and "-dev"/"-prod" suffixes.
function baseName(title) {
  return title
    .replace(
      /\s*\((?:production build|production|prod mode|prod|dev mode|dev)\)\s*$/i,
      "",
    )
    .replace(/[-_](?:production|prod|dev)$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * @param {AllowlistEntry[]} allowlist
 * @param {{ base: string, file: string }} gap
 */
function isAllowlisted(allowlist, gap) {
  const rel = path.relative(REPO_ROOT, gap.file).replaceAll("\\", "/");
  return allowlist.some((e) => {
    if (e.base.toLowerCase() !== gap.base) return false;
    if (!e.file) return true;
    const want = e.file.replaceAll("\\", "/");
    return rel === want || rel.endsWith("/" + want);
  });
}

const allowlist = loadAllowlist();

let totalMissing = 0;
let suitesWithGaps = 0;
let totalAllowlisted = 0;
/** @type {{ base: string, title: string, file: string, line: number }[]} */
const strictGaps = [];
const guardBlind = []; // describes the static guard cannot classify (non-literal mode)

for (const suite of splitSuites()) {
  const root = path.join(suite.dir, suite.testDir);
  const files = walk(root, isTestFile);

  // Production bases are per-file so an unrelated twin title in another file
  // cannot silently satisfy a missing production describe in this file.
  /** @type {Map<string, Set<string>>} */
  const prodBasesByFile = new Map();
  /** @type {{ base: string, title: string, file: string, line: number }[]} */
  const devOnly = [];

  // First pass: collect production-bucket base names per file.
  const topLevel = [];
  for (const file of files) {
    for (const d of scanFile(file, suite.prodGrep)) {
      if (d.indeterminate) {
        guardBlind.push({
          file,
          line: d.line,
          title: d.fullPath || "(dynamic title)",
        });
      }
      if (d.fullPath.includes(" > ")) continue; // only top-level describes
      if (d.title === "") continue; // dynamic (non-literal) title: cannot pair
      // Nested helper describes (themeTests, notFoundTests, …) call test.describe
      // without wiring their own useFixture — they are not fixture roots and are
      // already covered by the parent that owns the twin pair. Skip them.
      if (!d.dev && !d.build && !d.indeterminate) continue;
      topLevel.push({ ...d, file });
      if (d.taggedProd) {
        let set = prodBasesByFile.get(file);
        if (!set) {
          set = new Set();
          prodBasesByFile.set(file, set);
        }
        set.add(baseName(d.title));
      }
    }
  }
  // Second pass: dev-bucket describes whose base has no production sibling in
  // the same file.
  for (const d of topLevel) {
    if (d.taggedProd) continue;
    const base = baseName(d.title);
    const prodBases = prodBasesByFile.get(d.file);
    if (!prodBases || !prodBases.has(base))
      devOnly.push({ base, title: d.title, file: d.file, line: d.line });
  }

  if (devOnly.length === 0) continue;
  suitesWithGaps++;
  totalMissing += devOnly.length;

  const allowed = [];
  const unallowed = [];
  for (const d of devOnly) {
    if (isAllowlisted(allowlist, d)) allowed.push(d);
    else unallowed.push(d);
  }
  totalAllowlisted += allowed.length;
  strictGaps.push(...unallowed);

  console.log(
    `\n${path.relative(REPO_ROOT, suite.dir)}: ${devOnly.length} dev describe(s) without a (production) sibling` +
      (allowed.length ? ` (${allowed.length} allowlisted)` : ""),
  );
  for (const d of unallowed) {
    console.log(
      `  - ${d.title}   (${path.relative(REPO_ROOT, d.file)}:${d.line})`,
    );
  }
  if (allowed.length > 0 && !STRICT) {
    for (const d of allowed) {
      console.log(
        `  ~ ${d.title}   (${path.relative(REPO_ROOT, d.file)}:${d.line}) [allowlisted]`,
      );
    }
  } else if (allowed.length > 0 && STRICT) {
    // In strict mode keep output short: only show unallowed gaps as failures.
    for (const d of allowed) {
      console.log(
        `  ~ ${d.title}   (${path.relative(REPO_ROOT, d.file)}:${d.line}) [allowlisted]`,
      );
    }
  }
}

const modeLabel = STRICT ? "strict" : "advisory";
console.log(
  `\nParity (${modeLabel}): ${totalMissing} dev-only describe(s) across ${suitesWithGaps} suite(s)` +
    (totalAllowlisted ? `; ${totalAllowlisted} allowlisted` : "") +
    (STRICT ? `; ${strictGaps.length} non-allowlisted` : "") +
    ".",
);
if (!STRICT) {
  console.log(
    "Some dev-only tests are intentional (HMR, dev-server-specific). Add a (production) twin where the scenario should also run against a build.",
  );
  console.log(
    "CI enforces: node tools/check-e2e-parity.mjs --strict (or E2E_PARITY_STRICT=1).",
  );
}

if (guardBlind.length > 0) {
  console.log(
    `\nGuard-blind describes (non-literal useFixture mode): ${guardBlind.length}. The bucketing guard cannot statically verify these, so the helper that generates them MUST couple mode: "build" with a (production) title:`,
  );
  for (const d of guardBlind) {
    console.log(
      `  - ${path.relative(REPO_ROOT, d.file)}:${d.line}  ${d.title}`,
    );
  }
}

if (STRICT && strictGaps.length > 0) {
  console.error(
    `\nE2E parity strict: ${strictGaps.length} non-allowlisted gap(s). ` +
      "Add a (production) twin, or an entry in tools/e2e-parity-allowlist.json with a reason.",
  );
  process.exit(1);
}

if (STRICT) {
  console.log("E2E parity strict: OK — no non-allowlisted gaps.");
}
