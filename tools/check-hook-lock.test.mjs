import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, globToRegExp, matchLocked } from "./check-hook-lock.mjs";

const config = JSON.parse(
  readFileSync(new URL("./hook-lock.json", import.meta.url), "utf8"),
);
const R = "packages/rangojs-router/src";
const LABEL = config.label;

test("unlocked change passes without label or link", () => {
  const r = evaluate(
    {
      changedFiles: [`${R}/router/match.ts`, "README.md"],
      labels: [],
      body: "",
    },
    config,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.locked, []);
});

test("locked file without label and link fails with both problems", () => {
  const r = evaluate(
    { changedFiles: [`${R}/browser/partial-update.ts`], labels: [], body: "x" },
    config,
  );
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
});

test("label without design link fails", () => {
  const r = evaluate(
    { changedFiles: [`${R}/use-loader.tsx`], labels: [LABEL], body: "no link" },
    config,
  );
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /link the hooks design/);
});

test("design link without label fails", () => {
  const r = evaluate(
    { changedFiles: [`${R}/use-loader.tsx`], labels: [], body: "see dc-d152" },
    config,
  );
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /missing label/);
});

test("label and design link pass (id or URL form)", () => {
  for (const body of [
    "Design: dc-t84@rangojs",
    "https://devcorner.devcorner.workers.dev/t/dc-t84@rangojs",
    "dc-d152",
  ]) {
    const r = evaluate(
      {
        changedFiles: [`${R}/browser/react/use-navigation.ts`],
        labels: [LABEL],
        body,
      },
      config,
    );
    assert.equal(r.ok, true, body);
  }
});

test("a longer id is not a design link", () => {
  const r = evaluate(
    { changedFiles: [`${R}/use-loader.tsx`], labels: [LABEL], body: "dc-t841" },
    config,
  );
  assert.equal(r.ok, false);
});

test("use-*.ts matches one segment only; sibling non-hook files are free", () => {
  const hit = matchLocked(
    [
      `${R}/browser/react/use-params.ts`,
      `${R}/browser/react/Link.tsx`,
      `${R}/browser/react/nested/use-x.ts`,
    ],
    config,
  );
  assert.deepEqual(hit, [`${R}/browser/react/use-params.ts`]);
});

test("lock tests and the guard itself are locked", () => {
  const files = [
    `${R}/__tests__/use-navigation-commit-lane.test.tsx`,
    "tools/hook-lock.json",
    ".github/workflows/hook-lock.yml",
  ];
  assert.deepEqual(matchLocked(files, config), files);
});

test("every locked literal path exists in the repo", async () => {
  const { existsSync } = await import("node:fs");
  const root = new URL("../", import.meta.url);
  for (const p of [
    ...config.commitFiles,
    ...config.lockTests,
    ...config.guardFiles,
  ]) {
    if (p.includes("*")) continue;
    assert.ok(existsSync(new URL(p, root)), `missing: ${p}`);
  }
});

test("globToRegExp: ** crosses segments, . is literal", () => {
  assert.ok(globToRegExp("a/**/b.ts").test("a/x/y/b.ts"));
  assert.ok(!globToRegExp("a.ts").test("aXts"));
});
