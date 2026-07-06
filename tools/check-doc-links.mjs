// Guard against a silent docs-rot class: a `../../src/...` link in one of the
// canonical internal maps pointing to a source path that no longer exists.
//
// docs/internal/feature-file-map.md (feature-to-source ownership) and
// docs/internal/feature-map.md (export surface) are the maps CLAUDE.md mandates
// stay in sync with the code. When a source file is renamed/moved, a stale link
// sends a contributor (or agent) to a dead path. This guard fails CI so the map
// is updated alongside the rename.
//
// For each map, every markdown link target matching `../../src/...` is resolved
// relative to the doc's directory and checked for existence (file OR directory).
// Directory owners are linked with a trailing slash (e.g. `route-types/`), which
// existsSync accepts. Any `#anchor` (and a defensive trailing `*`, in case a
// `/*` glob target is ever added) is stripped before resolving.
//
// Run: node tools/check-doc-links.mjs   (exits non-zero on any missing path)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const DOCS = [
  "packages/rangojs-router/docs/internal/feature-file-map.md",
  "packages/rangojs-router/docs/internal/feature-map.md",
];

// Match the path inside a markdown link target: ](../../src/...) or
// ](../../skills/...).
const SRC_LINK = /\]\((\.\.\/\.\.\/(?:src|skills)\/[^)]+)\)/g;

const missing = [];

for (const docRel of DOCS) {
  const docAbs = path.join(REPO_ROOT, docRel);
  const docDir = path.dirname(docAbs);
  const text = fs.readFileSync(docAbs, "utf8");

  let match;
  while ((match = SRC_LINK.exec(text)) !== null) {
    const rawTarget = match[1];
    // Strip any in-file anchor, then a defensive trailing glob `*`.
    const cleaned = rawTarget.replace(/[#?].*$/, "").replace(/\*+$/, "");
    const resolved = path.resolve(docDir, cleaned);
    if (!fs.existsSync(resolved)) {
      missing.push({ doc: docRel, target: rawTarget });
    }
  }
}

if (missing.length > 0) {
  console.error(
    `Doc-link guard: ${missing.length} internal-map link(s) point to a missing src path:\n`,
  );
  for (const m of missing) {
    console.error(`  ${m.doc}\n    -> ${m.target}`);
  }
  console.error(
    "\nA stale src link in an internal map sends contributors to a dead path.\n" +
      "Fix: repoint the link to the file's real location (or remove it if the\n" +
      "file was deleted), then re-run `pnpm check:doc-links`.\n",
  );
  process.exit(1);
}

console.log("Doc-link guard: OK — every internal-map src link resolves.");
