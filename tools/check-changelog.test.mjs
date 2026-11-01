import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  isConsumerSource,
  optOutReason,
  unreleasedSection,
} from "./check-changelog.mjs";

const SRC = "packages/rangojs-router/src/router/match.ts";
const BASE =
  "# Changelog\n\n## Unreleased\n\n### Fix: old\n\n## 0.32.0\n\n- a\n";
const WITH_ENTRY = BASE.replace("### Fix: old", "### Fix: old\n\n### Fix: new");
const RELEASED_EDIT = BASE.replace("- a", "- a edited");

const run = (over) =>
  evaluate({
    changedFiles: [SRC],
    body: "",
    title: "fix(router): x",
    draft: false,
    baseChangelog: BASE,
    headChangelog: BASE,
    ...over,
  });

test("source change with an Unreleased entry passes", () => {
  assert.equal(run({ headChangelog: WITH_ENTRY }).ok, true);
});

test("source change with no entry fails", () => {
  const r = run({});
  assert.equal(r.ok, false);
  assert.deepEqual(r.sources, [SRC]);
});

test("opt-out line with a reason passes", () => {
  assert.equal(
    run({ body: "x\nNo CHANGELOG entry: internal refactor\n" }).ok,
    true,
  );
});

test("opt-out line with an empty reason fails", () => {
  assert.equal(run({ body: "No CHANGELOG entry:   \n" }).ok, false);
  assert.equal(run({ body: "No CHANGELOG entry:\nnext line" }).ok, false);
});

test("test-only changes pass", () => {
  const changedFiles = [
    "packages/rangojs-router/src/__tests__/a.ts",
    "packages/rangojs-router/src/router/x.test.ts",
    "packages/rangojs-router/src/router/y.rsc-test.tsx",
    "packages/rangojs-router/e2e/z.ts",
  ];
  const r = run({ changedFiles });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sources, []);
});

test("an edit in a released section does not count", () => {
  assert.equal(run({ headChangelog: RELEASED_EDIT }).ok, false);
});

test("removing the Unreleased content does not count", () => {
  const head = BASE.replace("### Fix: old\n\n", "");
  assert.equal(run({ headChangelog: head }).ok, false);
});

test("CLI source counts", () => {
  assert.equal(
    run({ changedFiles: ["packages/rangojs-router/src/bin/rango.ts"] }).ok,
    false,
  );
});

test("draft and release PRs are exempt", () => {
  assert.equal(run({ draft: true }).exempt, "draft");
  assert.equal(run({ title: "chore(release): 0.33.0" }).exempt, "release");
});

test("helpers", () => {
  assert.equal(isConsumerSource(SRC), true);
  assert.equal(isConsumerSource("docs/x.md"), false);
  assert.equal(unreleasedSection("# C\n"), null);
  assert.equal(optOutReason("no changelog entry: why"), "why");
});
