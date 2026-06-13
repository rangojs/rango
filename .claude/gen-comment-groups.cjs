const { execSync } = require("child_process");
const fs = require("fs");
const ROOT = "/Users/ivotodorov/Development/vite-rsc-2";
const OUT = `${ROOT}/.claude/comment-groups.json`;

// Shipped source only: no tests, mocks, generated, decl, or type-check files.
const cmd =
  "find packages/rangojs-router/src -type f \\( -name '*.ts' -o -name '*.tsx' \\) " +
  "! -path '*__tests__*' ! -path '*__mocks__*' ! -path '*__augment-tests__*' " +
  "! -name '*.test.*' ! -name '*.gen.ts' ! -name '*.d.ts' ! -name '*.check.ts' " +
  "! -name '*.entry.ts'";
const files = execSync(cmd, { cwd: ROOT, encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort(); // path-sorted so chunks stay directory-affine

const CHUNK = 18; // ~19 groups for "mass" parallelism
const groups = [];
for (let i = 0; i < files.length; i += CHUNK) {
  groups.push({ group: `g${groups.length + 1}`, files: files.slice(i, i + CHUNK) });
}

fs.writeFileSync(OUT, JSON.stringify(groups, null, 2));
console.log(`${files.length} files -> ${groups.length} groups (~${CHUNK}/group)`);
console.log(`wrote ${OUT}`);
