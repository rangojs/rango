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
  report,
  scanSource,
  validateBaseline,
} from "./check-internals.mjs";

const SRC = "packages/rangojs-router/src/";
const lines = (file, rule, src) =>
  scanSource(file, src.join("\n"))
    .filter((h) => h.rule === rule)
    .map((h) => h.line);

// ---- rule 1: Object.create of a RequestContext ----------------------------

test("object-create: a parameter or variable typed RequestContext", () => {
  const src = [
    "export function a(reqCtx: RequestContext<any>) {",
    "  return Object.create(reqCtx);",
    "}",
    "export function b(reqCtx: RequestContext | undefined) {",
    "  const base: ns.RequestContext = getOther();",
    "  return [Object.create(reqCtx!), Object.create(base)];",
    "}",
  ];
  assert.deepEqual(lines(`${SRC}rsc/x.ts`, RULE_OBJECT_CREATE, src), [2, 6, 6]);
});

test("object-create: a factory call, directly or through a variable", () => {
  const src = [
    "export function a() {",
    "  const base = getRequestContext();",
    "  const alias = base;",
    "  Object.create(alias);",
    "  Object.create(_getRequestContext()!);",
    "  return Object.assign(Object.create(createRequestContext({})), {});",
    "}",
  ];
  assert.deepEqual(
    lines(`${SRC}router/x.ts`, RULE_OBJECT_CREATE, src),
    [4, 5, 6],
  );
});

test("object-create: a context derived from one, by Object.create, Object.assign or a helper", () => {
  const src = [
    "export function a(reqCtx: RequestContext) {",
    "  const child = Object.create(reqCtx);",
    "  const grandchild = Object.create(child);",
    "  const sink = Object.assign(createRequestContext({}), { x: 1 });",
    "  return [grandchild, Object.create(sink)];",
    "}",
    "function derive(c: RequestContext) {",
    "  return Object.create(c);",
    "}",
    "export const b = (c: RequestContext) => Object.create(derive(c));",
  ];
  assert.deepEqual(
    lines(`${SRC}rsc/x.ts`, RULE_OBJECT_CREATE, src),
    [2, 3, 5, 8, 10],
  );
});

test("object-create: a same-file helper that returns or is annotated RequestContext", () => {
  const src = [
    "function makeCtx(store: Store) {",
    "  if (!store) throw new Error();",
    "  return createRequestContext({ cacheStore: store });",
    "}",
    "const annotated = (): RequestContext<any> => build();",
    "it('derives', () => {",
    "  const req = makeCtx(store);",
    "  const derived = () => Object.create(req) as typeof req;",
    "  Object.create(annotated());",
    "});",
  ];
  assert.deepEqual(
    lines(`${SRC}cache/__tests__/a.test.ts`, RULE_OBJECT_CREATE, src),
    [8, 9],
  );
});

test("object-create: the result typed RequestContext, and casts either way", () => {
  const src = [
    "export function a(other: unknown) {",
    "  const t: RequestContext<any> = Object.create(other as object);",
    "  const u = Object.create(other as object) as RequestContext;",
    "  const v = Object.create(other as RequestContext);",
    "  const w: RequestContext = Object.assign(Object.create(other), {});",
    "  return [t, u, v, w];",
    "}",
    "export const f = (o: object): RequestContext => Object.create(o);",
    "export function g(o: object): RequestContext {",
    "  return Object.create(o);",
    "}",
    "export function h(ctx: RequestContext) {",
    "  return Object.create(ctx as object);",
    "}",
  ];
  assert.deepEqual(
    lines(`${SRC}rsc/x.ts`, RULE_OBJECT_CREATE, src),
    [2, 3, 4, 5, 8, 10, 13],
  );
});

test("object-create: other contexts, plain objects and look-alike types are not reported", () => {
  const src = [
    "export function a(ctx: HandlerContext<any>) {",
    "  return Object.create(ctx, { use: { value: 1 } });",
    "}",
    "export function b<C>(ctx: C) { return Object.create(ctx as object); }",
    "export const dict = Object.create(null);",
    "export function c(RequestContextLike: unknown) {",
    "  return Object.create(RequestContextLike);",
    "}",
    'export function d(use: RequestContext["use"], p: Partial<RequestContext>) {',
    "  return [Object.create(use), Object.create(p)];",
    "}",
    "export function e(ctx: RequestContext) {",
    "  return Object.create(ctx.Store);",
    "}",
    "const fg = { _prerenderWarm: 1 };",
    "export const f = Object.create(fg) as typeof fg;",
    "export const g = Object.create(importedCtx);",
    "export function h({ env }: RequestContext) {",
    "  const { variables } = getRequestContext();",
    "  return [Object.create(env), Object.create(variables)];",
    "}",
  ];
  assert.deepEqual(lines(`${SRC}router/x.ts`, RULE_OBJECT_CREATE, src), []);
});

test("object-create: the nearest declaration wins when a name is shadowed", () => {
  const src = [
    "function outer(ctx: RequestContext<any>) {",
    "  function inner(ctx: HandlerContext<any>) {",
    "    return Object.create(ctx);",
    "  }",
    "  for (const ctx of handlers) Object.create(ctx);",
    "  try {} catch (ctx) { Object.create(ctx as object); }",
    "  items.map(({ ctx }) => Object.create(ctx));",
    "  items.map(([ctx]) => Object.create(ctx));",
    "  { const { ctx } = opts; Object.create(ctx); }",
    "  return Object.create(ctx);",
    "}",
  ];
  assert.deepEqual(lines(`${SRC}router/x.ts`, RULE_OBJECT_CREATE, src), [10]);
});

test("object-create: render-pass.ts and files outside the router source are exempt", () => {
  const src = [
    "export function derive(base: RequestContext<any>) {",
    "  return Object.create(base);",
    "}",
  ];
  assert.deepEqual(
    lines(`${SRC}server/render-pass.ts`, RULE_OBJECT_CREATE, src),
    [],
  );
  assert.deepEqual(
    lines("tests/cloudflare-basic/src/x.ts", RULE_OBJECT_CREATE, src),
    [],
  );
  assert.deepEqual(
    lines(`${SRC}server/__tests__/x.test.ts`, RULE_OBJECT_CREATE, src),
    [2],
  );
});

// ---- rule 2: vi.mock of router code ---------------------------------------

test("vi-mock: relative specifiers, multi-line, vi.doMock and the import() form", () => {
  const src = [
    'vi.mock("../../server/request-context.js", () => ({}));',
    "vi.mock(",
    '  "./sibling.js",',
    "  () => ({}),",
    ");",
    'vi.doMock("../x.js", () => ({}));',
    'vi.mock(import("./typed.js"), () => ({}));',
  ];
  const file = `${SRC}rsc/__tests__/a.test.ts`;
  assert.deepEqual(lines(file, RULE_VI_MOCK, src), [1, 2, 6, 7]);
  const [first] = scanSource(file, src.join("\n"));
  assert.match(
    first.message,
    /vi\.mock of internal module "\.\.\/\.\.\/server\/request-context\.js"/,
  );
});

test("vi-mock: @rangojs everywhere; a root-relative path only from the router source", () => {
  const src = [
    'vi.mock("/src/router/x.ts");',
    'vi.mock("~/lib/db");',
    'vi.mock("@/lib/db");',
    'vi.mock("@rangojs/router/internal/rsc-handler");',
  ];
  assert.deepEqual(
    lines(`${SRC}rsc/__tests__/a.test.ts`, RULE_VI_MOCK, src),
    [1, 4],
  );
  for (const file of [
    "packages/rangojs-router/e2e/mini/test/x.test.ts",
    "tests/cloudflare-basic/test/x.test.ts",
  ]) {
    assert.deepEqual(lines(file, RULE_VI_MOCK, src), [4], file);
  }
});

test("vi-mock: bare specifiers, computed specifiers and other calls are allowed", () => {
  const src = [
    'vi.mock("@vitejs/plugin-rsc/rsc/server", () => ({}));',
    'vi.mock("react", () => ({}));',
    'vi.mock("node:fs", () => ({}));',
    'vi.mock(import("@vitejs/plugin-rsc/rsc/client"), () => ({}));',
    "vi.mock(someVariable, () => ({}));",
    'vi.unmock("./x.js");',
    'vi.importActual("./x.js");',
    'foo.mock("./x.js");',
  ];
  assert.deepEqual(
    lines(`${SRC}rsc/__tests__/a.test.ts`, RULE_VI_MOCK, src),
    [],
  );
});

test("vi-mock: an app's own module is allowed, a relative path into the router source is not", () => {
  const own = ['vi.mock("./local.js");', 'vi.mock("../src/db.js");'];
  for (const file of [
    "tests/cloudflare-basic/test/x.test.ts",
    "examples/a/x.test.ts",
    "packages/rangojs-router/e2e/mini/test/x.test.ts",
  ]) {
    assert.deepEqual(lines(file, RULE_VI_MOCK, own), [], file);
  }
  const router = [
    'vi.mock("../../../packages/rangojs-router/src/rsc/handler.js");',
    'vi.mock("@rangojs/router");',
  ];
  for (const file of [
    "tests/a/b/x.test.ts",
    "examples/a/b/x.test.ts",
    "apps/a/b/x.test.ts",
  ]) {
    assert.deepEqual(lines(file, RULE_VI_MOCK, router), [1, 2], file);
  }
  assert.deepEqual(
    lines("packages/rangojs-router/test/x.test.ts", RULE_VI_MOCK, own),
    [2],
  );
  assert.deepEqual(
    lines(`${SRC}vite/__tests__/x.test.ts`, RULE_VI_MOCK, [
      'vi.mock("../../../e2e/mini/src/x.js");',
    ]),
    [],
  );
  assert.deepEqual(lines("tools/x.test.mjs", RULE_VI_MOCK, router), []);
});

// ---- rule 3: _rsc_ literals -----------------------------------------------

test("rsc-literal: a name at the start, or after ? or &, in any literal", () => {
  const src = [
    'const a = "_rsc_partial";',
    "const b = `_rsc_segments`;",
    "const c = `_rsc_rid=${id}`;",
    "url.searchParams.set('_rsc_v', v);",
    'fetch("/?_rsc_warmup");',
    "const d = `${path}?_rsc_partial=1&_rsc_v=${v}`;",
    "const e = `${path}?x=${x}&_rsc_rt=${t}`;",
    'type P = "_rsc_action";',
  ];
  assert.deepEqual(
    lines(`${SRC}browser/x.ts`, RULE_RSC_LITERAL, src),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test("rsc-literal: a name spelled as an identifier", () => {
  const src = [
    'const p = new URLSearchParams({ _rsc_partial: "1" });',
    "const v = params._rsc_v;",
  ];
  assert.deepEqual(lines(`${SRC}rsc/x.ts`, RULE_RSC_LITERAL, src), [1, 2]);
});

test("rsc-literal: other names, comments, module paths, wire-params.ts and tests are not reported", () => {
  const other = [
    "// reads _rsc_partial",
    "/** `_rsc_segments` */",
    'const a = "/__rsc_shell";',
    "const b = `__rsc_ls_${key}`;",
    'const c = "__vite_rsc_require__";',
    'const d = "x_rsc_partial";',
    'import "./_rsc_like.js";',
    "const e = `${prefix}_rsc_cache`;",
    "const f = obj.__rsc_ls_key;",
  ];
  assert.deepEqual(lines(`${SRC}browser/x.ts`, RULE_RSC_LITERAL, other), []);
  const owner = ['export const WIRE = { partial: "_rsc_partial" };'];
  assert.deepEqual(lines(`${SRC}wire-params.ts`, RULE_RSC_LITERAL, owner), []);
  assert.deepEqual(
    lines(`${SRC}browser/__tests__/a.test.ts`, RULE_RSC_LITERAL, owner),
    [],
  );
  assert.deepEqual(
    lines("tests/cloudflare-basic/e2e/a.ts", RULE_RSC_LITERAL, owner),
    [],
  );
});

// ---- rule 4: browser/ imports into the server graph -----------------------

test("browser-import: every runtime import form is reported", () => {
  const src = [
    'import { a } from "../browser/navigation-client.js";',
    'export { b } from "../browser/partial-update.js";',
    'export * from "../browser/types.js";',
    'const m = await import("../browser/prefetch/cache.js");',
    'const r = require("../browser/history-state.js");',
    'import "../browser/side-effect.js";',
    'import c, { type D } from "../browser/react/location-state-shared.js";',
    'import e = require("../browser/legacy.js");',
    'import { f } from "../browser";',
  ];
  assert.deepEqual(
    lines(`${SRC}router/x.ts`, RULE_BROWSER_IMPORT, src),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test("browser-import: a deeper importer resolves its relative path", () => {
  const src = ['import { a } from "../../browser/navigation-client.js";'];
  assert.deepEqual(
    lines(`${SRC}router/match-middleware/x.ts`, RULE_BROWSER_IMPORT, src),
    [1],
  );
  assert.deepEqual(lines(`${SRC}cache/cf/x.ts`, RULE_BROWSER_IMPORT, src), [1]);
});

test("browser-import: type-only imports, the L0 helpers and other paths are allowed", () => {
  const src = [
    'import type { A } from "../browser/types.js";',
    'import { type B, type C } from "../browser/types.js";',
    'export type { D } from "../browser/types.js";',
    'export { type E } from "../browser/types.js";',
    'type F = import("../browser/types.js").F;',
    'import { cookie } from "../browser/cookie-name.js";',
    'import { isInterceptSegment } from "../browser/intercept-utils.js";',
    'import { f } from "../browser/react/filter-segment-order.js";',
    'import { ok } from "../urls/x.js";',
    'import { pkg } from "browser/anything";',
    'import { g } from "../browser-like/x.js";',
  ];
  assert.deepEqual(lines(`${SRC}rsc/x.ts`, RULE_BROWSER_IMPORT, src), []);
});

test("browser-import: an L0 helper may import another L0 helper, nothing else in browser/", () => {
  const src = [
    'import { loaderParentId } from "./react/filter-segment-order.js";',
    'import type { ResolvedSegment } from "./types.js";',
    'import { navigate } from "./navigation-client.js";',
  ];
  assert.deepEqual(
    lines(`${SRC}browser/intercept-utils.ts`, RULE_BROWSER_IMPORT, src),
    [3],
  );
});

test("browser-import: only non-test server, rsc, router and cache source is in scope", () => {
  const src = ['import { a } from "../browser/navigation-client.js";'];
  for (const file of [
    `${SRC}testing/x.ts`,
    `${SRC}ssr/x.ts`,
    `${SRC}rsc/__tests__/x.test.ts`,
  ]) {
    assert.deepEqual(lines(file, RULE_BROWSER_IMPORT, src), [], file);
  }
  const nested = ['import { a } from "../navigation-client.js";'];
  assert.deepEqual(
    lines(`${SRC}browser/react/x.ts`, RULE_BROWSER_IMPORT, nested),
    [],
  );
});

// ---- counts and baseline --------------------------------------------------

const hit = (rule, file, line = 1) => ({ rule, file, line, message: "m" });
const baselineOf = (rules) => ({ version: 1, rules });

test("countHits groups per rule and file in code-unit order", () => {
  const counts = countHits([
    hit(RULE_VI_MOCK, "b.ts"),
    hit(RULE_VI_MOCK, "a.ts"),
    hit(RULE_VI_MOCK, "B.ts"),
    hit(RULE_VI_MOCK, "b.ts"),
    hit(RULE_RSC_LITERAL, "c.ts"),
  ]);
  assert.deepEqual(Object.entries(counts[RULE_VI_MOCK]), [
    ["B.ts", 1],
    ["a.ts", 1],
    ["b.ts", 2],
  ]);
  assert.deepEqual(counts[RULE_RSC_LITERAL], { "c.ts": 1 });
  assert.deepEqual(counts[RULE_OBJECT_CREATE], {});
});

test("compareToBaseline classifies a rise, a new file, a drop and a removed file", () => {
  const baseline = baselineOf({
    [RULE_VI_MOCK]: { "a.ts": 2, "b.ts": 3, "gone.ts": 1 },
  });
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
  assert.deepEqual(compareToBaseline(undefined, countHits([])), {
    increases: [],
    decreases: [],
  });
});

test("nextBaseline locks gains in, keeps raises at the baseline, and raises only when allowed", () => {
  const baseline = baselineOf({ [RULE_VI_MOCK]: { "a.ts": 2, "b.ts": 2 } });
  const counts = countHits([
    hit(RULE_VI_MOCK, "a.ts"),
    ...Array(3).fill(hit(RULE_VI_MOCK, "b.ts")),
    hit(RULE_VI_MOCK, "new.ts"),
  ]);

  const kept = nextBaseline(baseline, counts, false);
  assert.deepEqual(kept.baseline.rules[RULE_VI_MOCK], { "a.ts": 1, "b.ts": 2 });
  assert.deepEqual(
    kept.refused.map((d) => d.file),
    ["b.ts", "new.ts"],
  );

  const raised = nextBaseline(baseline, counts, true);
  assert.deepEqual(raised.baseline.rules[RULE_VI_MOCK], {
    "a.ts": 1,
    "b.ts": 3,
    "new.ts": 1,
  });
  assert.deepEqual(raised.refused, []);
  assert.deepEqual(validateBaseline(raised.baseline), []);
});

test("validateBaseline rejects a wrong shape, an unknown rule and a bad count", () => {
  assert.deepEqual(validateBaseline(baselineOf({ [RULE_VI_MOCK]: {} })), []);
  assert.equal(validateBaseline([]).length, 1);
  assert.equal(validateBaseline({ version: 2, rules: {} }).length, 1);
  assert.equal(validateBaseline({ version: 1 }).length, 1);
  assert.match(
    validateBaseline(baselineOf({ "internal-vi-mocks": {} })).join(),
    /unknown rule "internal-vi-mocks"/,
  );
  assert.equal(
    validateBaseline(baselineOf({ [RULE_VI_MOCK]: { "a.ts": 0, "b.ts": 1.5 } }))
      .length,
    2,
  );
});

test("report passes on an exact match and lists each hit of a raised file", () => {
  const hits = [hit(RULE_VI_MOCK, "a.ts", 4), hit(RULE_VI_MOCK, "a.ts", 9)];
  const run = (n) =>
    report(baselineOf({ [RULE_VI_MOCK]: { "a.ts": n } }), hits, 7);

  const same = run(2);
  assert.equal(same.ok, true);
  assert.match(same.lines.at(-1), /OK \(7 files scanned; .*internal-vi-mock 2/);

  const raised = run(1);
  assert.equal(raised.ok, false);
  assert.deepEqual(raised.lines.slice(0, 3), [
    "internal-vi-mock  a.ts  baseline 1, now 2",
    "  a.ts:4  m",
    "  a.ts:9  m",
  ]);
  assert.match(raised.lines[3], /above the baseline.*--allow-raise/);

  const stale = run(3);
  assert.equal(stale.ok, false);
  assert.match(stale.lines.at(-1), /below the baseline.*--update$/);
});
