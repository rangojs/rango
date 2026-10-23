import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RULE_BROWSER_IMPORT,
  RULE_OBJECT_CREATE,
  RULE_RSC_LITERAL,
  RULE_VI_MOCK,
  compareToBaseline,
  countHits,
  nextBaseline,
  scanSource,
} from "./check-internals.mjs";

const SRC = "packages/rangojs-router/src/";
const by = (hits, rule) => hits.filter((h) => h.rule === rule);

// ---- rule 1: Object.create of a RequestContext ----------------------------

test("object-create: parameter typed RequestContext is reported with its line", () => {
  const src = [
    'import type { RequestContext } from "../server/request-context.js";',
    "export function derive(reqCtx: RequestContext<any>) {",
    "  return Object.create(reqCtx);",
    "}",
  ].join("\n");
  const hits = by(scanSource(`${SRC}rsc/x.ts`, src), RULE_OBJECT_CREATE);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

test("object-create: Object.assign wrapper and a variable from getRequestContext", () => {
  const src = [
    "export function a() {",
    "  const base = getRequestContext();",
    "  return Object.assign(Object.create(base), { x: 1 });",
    "}",
  ].join("\n");
  assert.equal(
    by(scanSource(`${SRC}router/x.ts`, src), RULE_OBJECT_CREATE).length,
    1,
  );
});

test("object-create: result typed RequestContext, and an `as RequestContext` cast", () => {
  const src = [
    "export function a(other: unknown) {",
    "  const t: RequestContext<any> = Object.create(other as object);",
    "  const u = Object.create(other as object) as RequestContext;",
    "  const v = Object.create(other as RequestContext);",
    "  return [t, u, v];",
    "}",
  ].join("\n");
  const hits = by(scanSource(`${SRC}rsc/x.ts`, src), RULE_OBJECT_CREATE);
  assert.deepEqual(
    hits.map((h) => h.line),
    [2, 3, 4],
  );
});

test("object-create: other contexts, null prototypes and render-pass.ts are not reported", () => {
  const handler = [
    "export function a(ctx: HandlerContext<any>) {",
    "  return Object.create(ctx, { use: { value: 1 } });",
    "}",
    "export function b(ctx: C) { return Object.create(ctx as object); }",
    "export const dict = Object.create(null);",
    "export function c(RequestContextLike: unknown) {",
    "  return Object.create(RequestContextLike);",
    "}",
  ].join("\n");
  assert.equal(
    by(scanSource(`${SRC}router/x.ts`, handler), RULE_OBJECT_CREATE).length,
    0,
  );
  const derive = [
    "export function d(base: RequestContext<any>) {",
    "  return Object.create(base);",
    "}",
  ].join("\n");
  assert.equal(
    by(scanSource(`${SRC}server/render-pass.ts`, derive), RULE_OBJECT_CREATE)
      .length,
    0,
  );
});

test("object-create: the nearest declaration wins when a name is shadowed", () => {
  const src = [
    "function outer(ctx: RequestContext<any>) {",
    "  function inner(ctx: HandlerContext<any>) {",
    "    return Object.create(ctx);",
    "  }",
    "  return inner;",
    "}",
  ].join("\n");
  assert.equal(
    by(scanSource(`${SRC}router/x.ts`, src), RULE_OBJECT_CREATE).length,
    0,
  );
});

// ---- rule 2: vi.mock of a relative module ---------------------------------

test("vi-mock: relative specifiers are reported, multi-line calls included", () => {
  const src = [
    'vi.mock("../../server/request-context.js", () => ({}));',
    "vi.mock(",
    '  "./sibling.js",',
    "  () => ({}),",
    ");",
    'vi.doMock("../x.js", () => ({}));',
  ].join("\n");
  const hits = by(
    scanSource(`${SRC}rsc/__tests__/a.test.ts`, src),
    RULE_VI_MOCK,
  );
  assert.deepEqual(
    hits.map((h) => h.line),
    [1, 2, 6],
  );
  assert.match(
    hits[0].message,
    /internal module "\.\.\/\.\.\/server\/request-context\.js"/,
  );
});

test("vi-mock: plugin-rsc runtime, react, platform and computed specifiers are allowed", () => {
  const src = [
    'vi.mock("@vitejs/plugin-rsc/rsc", () => ({}));',
    'vi.mock("react", () => ({}));',
    'vi.mock("node:fs", () => ({}));',
    "vi.mock(someVariable, () => ({}));",
    'foo.mock("./x.js");',
    'vi.fn("./x.js");',
  ].join("\n");
  assert.equal(
    by(scanSource(`${SRC}rsc/__tests__/a.test.ts`, src), RULE_VI_MOCK).length,
    0,
  );
});

test("vi-mock: counted in consumer test roots, ignored outside the scanned roots", () => {
  const src = 'vi.mock("./local.js");';
  assert.equal(
    by(scanSource("tests/cloudflare-basic/x.test.ts", src), RULE_VI_MOCK)
      .length,
    1,
  );
  assert.equal(by(scanSource("docs/x.test.ts", src), RULE_VI_MOCK).length, 0);
});

// ---- rule 3: _rsc_ string literals ----------------------------------------

test("rsc-literal: string, template and template-head literals are reported", () => {
  const src = [
    'const a = "_rsc_partial";',
    "const b = `_rsc_segments`;",
    "const c = `_rsc_rid=${id}`;",
    "url.searchParams.set('_rsc_v', v);",
  ].join("\n");
  const hits = by(scanSource(`${SRC}browser/x.ts`, src), RULE_RSC_LITERAL);
  assert.deepEqual(
    hits.map((h) => h.line),
    [1, 2, 3, 4],
  );
});

test("rsc-literal: wire-params.ts, tests, comments and mid-string occurrences are not reported", () => {
  const src = 'export const WIRE = { partial: "_rsc_partial" };';
  assert.equal(
    by(scanSource(`${SRC}wire-params.ts`, src), RULE_RSC_LITERAL).length,
    0,
  );
  assert.equal(
    by(scanSource(`${SRC}browser/__tests__/a.test.ts`, src), RULE_RSC_LITERAL)
      .length,
    0,
  );
  const other = [
    "// reads _rsc_partial",
    "/** `_rsc_segments` */",
    'const a = "x?_rsc_partial=1";',
    'const b = "rsc_partial";',
  ].join("\n");
  assert.equal(
    by(scanSource(`${SRC}browser/x.ts`, other), RULE_RSC_LITERAL).length,
    0,
  );
});

// ---- rule 4: browser/ imports into the server graph -----------------------

test("browser-import: runtime import, export-from, dynamic import and require are reported", () => {
  const src = [
    'import { a } from "../browser/navigation-client.js";',
    'export { b } from "../browser/partial-update.js";',
    'const m = await import("../browser/prefetch/cache.js");',
    'const r = require("../browser/history-state.js");',
    'import "../browser/side-effect.js";',
    'import c, { type D } from "../browser/react/location-state-shared.js";',
  ].join("\n");
  const hits = by(scanSource(`${SRC}router/x.ts`, src), RULE_BROWSER_IMPORT);
  assert.deepEqual(
    hits.map((h) => h.line),
    [1, 2, 3, 4, 5, 6],
  );
});

test("browser-import: the deeper relative path resolves against the importer", () => {
  const src = 'import { a } from "../../browser/navigation-client.js";';
  assert.equal(
    by(
      scanSource(`${SRC}router/match-middleware/x.ts`, src),
      RULE_BROWSER_IMPORT,
    ).length,
    1,
  );
  assert.equal(
    by(scanSource(`${SRC}cache/cf/x.ts`, src), RULE_BROWSER_IMPORT).length,
    1,
  );
});

test("browser-import: type-only imports, the L0 helpers and other directories are allowed", () => {
  const src = [
    'import type { A } from "../browser/types.js";',
    'import { type B, type C } from "../browser/types.js";',
    'export type { D } from "../browser/types.js";',
    'import { cookie } from "../browser/cookie-name.js";',
    'import { isInterceptSegment } from "../browser/intercept-utils.js";',
    'import { f } from "../browser/react/filter-segment-order.js";',
    'import { ok } from "../urls/x.js";',
    'import { pkg } from "browser/anything";',
    'import { e } from "./browser-like/x.js";',
  ].join("\n");
  assert.equal(
    by(scanSource(`${SRC}rsc/x.ts`, src), RULE_BROWSER_IMPORT).length,
    0,
  );
});

test("browser-import: only server/rsc/router/cache source files are in scope", () => {
  const src = 'import { a } from "../browser/navigation-client.js";';
  assert.equal(
    by(scanSource(`${SRC}testing/x.ts`, src), RULE_BROWSER_IMPORT).length,
    0,
  );
  assert.equal(
    by(scanSource(`${SRC}browser/react/x.ts`, src), RULE_BROWSER_IMPORT).length,
    0,
  );
  assert.equal(
    by(scanSource(`${SRC}rsc/__tests__/x.test.ts`, src), RULE_BROWSER_IMPORT)
      .length,
    0,
  );
});

// ---- counts and baseline --------------------------------------------------

const hit = (rule, file) => ({ rule, file, line: 1, message: "" });

test("countHits groups per rule and file in sorted order", () => {
  const counts = countHits([
    hit(RULE_VI_MOCK, "b.ts"),
    hit(RULE_VI_MOCK, "a.ts"),
    hit(RULE_VI_MOCK, "b.ts"),
    hit(RULE_RSC_LITERAL, "c.ts"),
  ]);
  assert.deepEqual(Object.entries(counts[RULE_VI_MOCK]), [
    ["a.ts", 1],
    ["b.ts", 2],
  ]);
  assert.deepEqual(counts[RULE_RSC_LITERAL], { "c.ts": 1 });
  assert.deepEqual(counts[RULE_OBJECT_CREATE], {});
});

const baselineOf = (rules) => ({ version: 1, rules });

test("compareToBaseline: equal counts pass; a rise, a new file and a drop are classified", () => {
  const baseline = baselineOf({
    [RULE_VI_MOCK]: { "a.ts": 2, "b.ts": 3, "gone.ts": 1 },
  });
  const same = compareToBaseline(
    baseline,
    countHits([
      ...Array(2).fill(hit(RULE_VI_MOCK, "a.ts")),
      ...Array(3).fill(hit(RULE_VI_MOCK, "b.ts")),
      hit(RULE_VI_MOCK, "gone.ts"),
    ]),
  );
  assert.deepEqual(same, { increases: [], decreases: [] });

  const changed = compareToBaseline(
    baseline,
    countHits([
      ...Array(3).fill(hit(RULE_VI_MOCK, "a.ts")),
      hit(RULE_VI_MOCK, "b.ts"),
      hit(RULE_VI_MOCK, "new.ts"),
    ]),
  );
  assert.deepEqual(
    changed.increases.map((d) => [d.file, d.was, d.now]),
    [
      ["a.ts", 2, 3],
      ["new.ts", 0, 1],
    ],
  );
  assert.deepEqual(
    changed.decreases.map((d) => [d.file, d.was, d.now]),
    [
      ["b.ts", 3, 1],
      ["gone.ts", 1, 0],
    ],
  );
});

test("compareToBaseline: a missing baseline treats every hit as an increase", () => {
  const { increases } = compareToBaseline(
    undefined,
    countHits([hit(RULE_RSC_LITERAL, "a.ts")]),
  );
  assert.equal(increases.length, 1);
});

test("nextBaseline lowers freely and refuses to raise unless allowed", () => {
  const baseline = baselineOf({ [RULE_VI_MOCK]: { "a.ts": 2 } });
  const lowered = nextBaseline(
    baseline,
    countHits([hit(RULE_VI_MOCK, "a.ts")]),
    false,
  );
  assert.deepEqual(lowered.refused, []);
  assert.deepEqual(lowered.baseline.rules[RULE_VI_MOCK], { "a.ts": 1 });

  const raisedHits = countHits([...Array(3).fill(hit(RULE_VI_MOCK, "a.ts"))]);
  const refused = nextBaseline(baseline, raisedHits, false);
  assert.equal(refused.baseline, undefined);
  assert.equal(refused.refused.length, 1);

  const allowed = nextBaseline(baseline, raisedHits, true);
  assert.deepEqual(allowed.baseline.rules[RULE_VI_MOCK], { "a.ts": 3 });
});
