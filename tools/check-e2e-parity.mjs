// Advisory dev/prod parity report: lists top-level describes that run in the dev
// bucket but have no matching (production) sibling, i.e. scenarios covered in dev
// mode but not in a production build. This catches the OTHER failure mode the
// bucketing guard cannot see — a missing production twin (vs. a mislabeled one).
//
// Warn-only: this never fails. Some dev-only tests are intentional (HMR, other
// dev-server-specific behavior). Treat the output as a review aid.
//
// Run: node tools/check-e2e-parity.mjs

import path from "node:path";
import {
  REPO_ROOT,
  isTestFile,
  scanFile,
  splitSuites,
  walk,
} from "./lib/e2e-bucketing-scan.mjs";

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

let totalMissing = 0;
let suitesWithGaps = 0;
const guardBlind = []; // describes the static guard cannot classify (non-literal mode)

for (const suite of splitSuites()) {
  const root = path.join(suite.dir, suite.testDir);
  const files = walk(root, isTestFile);

  const prodBases = new Set();
  const devOnly = []; // { base, title, file, line }

  // First pass: collect every production-bucket base name across the suite.
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
      topLevel.push({ ...d, file });
      if (d.taggedProd) prodBases.add(baseName(d.title));
    }
  }
  // Second pass: dev-bucket describes whose base has no production sibling.
  for (const d of topLevel) {
    if (d.taggedProd) continue;
    const base = baseName(d.title);
    if (!prodBases.has(base))
      devOnly.push({ base, title: d.title, file: d.file, line: d.line });
  }

  if (devOnly.length === 0) continue;
  suitesWithGaps++;
  totalMissing += devOnly.length;
  console.log(
    `\n${path.relative(REPO_ROOT, suite.dir)}: ${devOnly.length} dev describe(s) without a (production) sibling`,
  );
  for (const d of devOnly) {
    console.log(
      `  - ${d.title}   (${path.relative(REPO_ROOT, d.file)}:${d.line})`,
    );
  }
}

console.log(
  `\nParity (advisory): ${totalMissing} dev-only describe(s) across ${suitesWithGaps} suite(s).`,
);
console.log(
  "Some dev-only tests are intentional (HMR, dev-server-specific). Add a (production) twin where the scenario should also run against a build.",
);

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
