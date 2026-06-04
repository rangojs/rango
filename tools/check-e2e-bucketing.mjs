// Guard against a silent e2e bug class: a test that runs against a production
// build (a `mode: "build"` preview/built server) but is bucketed into the "dev"
// Playwright project because its describe title is not matched by the suite's
// production grep (and the inverse: a production-titled describe wired to the
// dev server).
//
// Enforced per split suite, using that suite's REAL production grep:
//   build-fixture describe => title matched by the production grep
//   dev-fixture describe    => title NOT matched by the production grep
//
// Nested describes inherit their ancestors' titles. Chained forms
// (test.describe.serial/only/skip/...) are recognized.
//
// Describes wiring useFixture({ mode }) with a non-literal mode (helper-driven
// dev/prod pairs) cannot be statically classified; they are reported as
// warnings, not failures, so their bucketing must be guaranteed by the helper.
//
// Run: node tools/check-e2e-bucketing.mjs   (exits non-zero on any violation)

import path from "node:path";
import { REPO_ROOT, scanSplitSuites } from "./lib/e2e-bucketing-scan.mjs";

const violations = [];
const warnings = [];

for (const { file, records } of scanSplitSuites()) {
  for (const d of records) {
    if (d.build && !d.taggedProd) {
      violations.push({ file, line: d.line, title: d.fullPath, kind: "build" });
    }
    if (d.dev && d.taggedProd) {
      violations.push({ file, line: d.line, title: d.fullPath, kind: "dev" });
    }
    // A non-literal mode means we cannot tell build from dev statically. If the
    // title is also dynamic, we cannot tell its bucket either: surface it.
    if (d.indeterminate && !d.build && !d.dev) {
      warnings.push({
        file,
        line: d.line,
        title: d.fullPath || "(dynamic title)",
      });
    }
  }
}

if (warnings.length > 0) {
  console.log(
    `E2E bucketing guard: ${warnings.length} describe(s) use a non-literal useFixture mode ` +
      "(helper-driven dev/prod pairs); their bucketing is trusted to the helper. " +
      "Run `pnpm check:e2e-parity` to list them.",
  );
}

if (violations.length > 0) {
  console.error(
    `E2E bucketing guard: ${violations.length} violation(s) found.\n`,
  );
  for (const v of violations) {
    console.error(`  ${path.relative(REPO_ROOT, v.file)}:${v.line}`);
    console.error(`    title: ${v.title}`);
    if (v.kind === "build") {
      console.error(
        "    issue: build fixture not matched by the production grep (lands in dev)",
      );
      console.error(
        '    fix:   tag the describe title with "(production)" (or use prodDescribe())\n',
      );
    } else {
      console.error("    issue: dev fixture under a production-matched title");
      console.error(
        "    fix:   remove the production tag from the title, or wire the build fixture\n",
      );
    }
  }
  console.error(
    "A production-mode test not matched by the production grep runs in the dev bucket — silent loss of production coverage.\n",
  );
  process.exit(1);
}

console.log(
  "E2E bucketing guard: OK — every build-fixture describe is correctly bucketed.",
);
