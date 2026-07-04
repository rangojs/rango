import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { x } from "tinyexec";

// Build-output guard (production-only by nature — there is no dev bundle to
// split; mirrors packages/rangojs-router/e2e/build-test-app.setup.ts). Each
// async include() group in src/urls.tsx (`() => import("./<group>.js")`) must
// stay a separate chunk. If one is statically imported into the worker entry,
// Rollup merges it in and no chunk bears its basename — this test then fails,
// catching the invisible re-inlining regression CLAUDE.md's Bundle Hygiene
// section describes (tree-shaking cannot catch it).
//
// WORKER_DIR is dist/rsc (wrangler's "main" resolves to dist/rsc/index.js;
// dist/client only holds static client assets and is excluded from the walk).

// Static groups plus every generated group module (derived from src/groups so
// scaling via scripts/gen-groups.mjs can't silently drop chunk coverage).
const GROUP_BASENAMES = [
  "localized-patterns",
  "included-patterns",
  "shop-patterns",
  "json-api-patterns",
  "app-like-patterns",
  "site-admin-patterns",
  "dup-cat-patterns",
  "dup-brand-patterns",
  "hub",
  "l1",
  "l2",
  "l3",
  ...fs
    .readdirSync(path.resolve("./src/groups"))
    .filter((f) => /^group-\d{3}\.ts$/.test(f))
    .map((f) => f.replace(/\.ts$/, "")),
];

function collectJsChunks(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          path.basename(full) === "client" &&
          path.dirname(full).endsWith("dist")
        )
          continue;
        stack.push(full);
      } else if (entry.isFile() && full.endsWith(".js")) {
        found.push(full);
      }
    }
  }
  return found;
}

test("async include() groups are code-split out of the worker entry", async () => {
  const cwd = path.resolve(".");
  const distDir = path.join(cwd, "dist");
  if (!fs.existsSync(distDir)) {
    await x("pnpm", ["build"], { nodeOptions: { cwd } });
  }
  const chunks = collectJsChunks(distDir);
  const missing = GROUP_BASENAMES.filter(
    (base) => !chunks.some((c) => path.basename(c).startsWith(base)),
  );
  expect(
    missing,
    `These async include() groups are NOT emitted as their own worker chunk — ` +
      `they were re-inlined into the entry (a static import crept in). Groups: ` +
      `${missing.join(", ")}. Worker JS chunks found:\n` +
      chunks.map((c) => `  ${path.relative(cwd, c)}`).join("\n"),
  ).toEqual([]);
});
