import { test } from "node:test";
import assert from "node:assert/strict";
import { scanPackageJson, scanSource } from "./check-no-external-store.mjs";

const HOOK = "no-use-sync-external-store";
const PKG = "no-store-package";
const DEP = "no-store-dependency";
const RENDER = "no-render-time-store-read";

const by = (hits, rule) => hits.filter((h) => h.rule === rule);

test("named import and call are both reported with lines", () => {
  const src = [
    'import { useSyncExternalStore } from "react";',
    "const v = useSyncExternalStore(sub, get);",
  ].join("\n");
  const hits = by(scanSource("packages/a/x.ts", src), HOOK);
  assert.deepEqual(
    hits.map((h) => h.line),
    [1, 2],
  );
  assert.match(
    hits[0].message,
    /named import of useSyncExternalStore from "react"/,
  );
  assert.match(hits[1].message, /reference to useSyncExternalStore/);
});

test("member access, element access and destructuring", () => {
  const src = [
    "React.useSyncExternalStore(a, b);",
    'React["useSyncExternalStore"](a, b);',
    "const { useSyncExternalStore } = React;",
  ].join("\n");
  const hits = by(scanSource("packages/a/x.ts", src), HOOK);
  assert.equal(hits.length, 3);
  assert.match(hits[0].message, /member access React\.useSyncExternalStore/);
  assert.match(
    hits[1].message,
    /element access React\["useSyncExternalStore"\]/,
  );
  assert.match(hits[2].message, /destructured useSyncExternalStore/);
  assert.deepEqual(
    hits.map((h) => h.line),
    [1, 2, 3],
  );
});

test("re-export is classified", () => {
  const hits = by(
    scanSource(
      "packages/a/x.ts",
      'export { useSyncExternalStore } from "react";',
    ),
    HOOK,
  );
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /re-export of useSyncExternalStore/);
});

test("shim package import reports package and identifier hits", () => {
  const src =
    'import { useSyncExternalStoreWithSelector } from "use-sync-external-store/with-selector";';
  const hits = scanSource("packages/a/x.ts", src);
  assert.equal(by(hits, PKG).length, 1);
  assert.equal(by(hits, HOOK).length, 1);
});

test("require, dynamic import, import-equals and export-from of the shim", () => {
  const src = [
    'const a = require("use-sync-external-store/shim");',
    'const b = await import("use-sync-external-store");',
    'import c = require("use-sync-external-store/shim");',
    'export * from "use-sync-external-store";',
  ].join("\n");
  const hits = by(scanSource("packages/a/x.ts", src), PKG);
  assert.deepEqual(
    hits.map((h) => h.line),
    [1, 2, 3, 4],
  );
});

test("unrelated packages with a similar prefix are not flagged", () => {
  const src = 'import x from "use-sync-external-store-lookalike";';
  assert.equal(scanSource("packages/a/x.ts", src).length, 0);
});

test("comments, JSDoc links and string literals are ignored", () => {
  const src = [
    "// useSyncExternalStore is banned",
    "/* useSyncExternalStore in a block comment */",
    "/**",
    " * See {@link useSyncExternalStore} and useSyncExternalStore.",
    " */",
    "export const x = 1;",
    'export const s = "useSyncExternalStore";',
    "export const t = `useSyncExternalStore`;",
  ].join("\n");
  assert.deepEqual(scanSource("packages/a/x.ts", src), []);
});

test("package.json dependency is reported at its line", () => {
  const text = [
    "{",
    '  "name": "x",',
    '  "dependencies": {',
    '    "use-sync-external-store": "^1.2.0"',
    "  }",
    "}",
  ].join("\n");
  const hits = scanPackageJson("packages/a/package.json", text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, DEP);
  assert.equal(hits[0].line, 4);
});

test("package.json without the dependency is clean", () => {
  const text = '{ "dependencies": { "react": "^19" } }';
  assert.deepEqual(scanPackageJson("package.json", text), []);
});

const HOOK_FILE = "packages/rangojs-router/src/browser/react/use-x.ts";

test("render-body store read is flagged; effects and lazy initializers are not", () => {
  const src = [
    "export function useX() {",
    "  const s = ctx.eventController.getState();",
    "  useEffect(() => { ctx.eventController.getState(); });",
    "  const [v] = useState(() => ctx.eventController.getState());",
    "  return s;",
    "}",
  ].join("\n");
  const hits = by(scanSource(HOOK_FILE, src), RENDER);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.match(hits[0].message, /called during render in useX/);
});

test("forwardRef component body is checked, optional chains included", () => {
  const src = [
    "export const Link = forwardRef(function Inner(props, ref) {",
    "  const o = ctx?.eventController.getState().location;",
    "  return null;",
    "});",
  ].join("\n");
  const hits = by(scanSource(HOOK_FILE, src), RENDER);
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /in Link;/);
});

test("memo(forwardRef(arrow)) anonymous arrow takes the variable name", () => {
  const src = [
    "export const Box = memo(forwardRef((props, ref) => {",
    "  return ctx.getActionState(1);",
    "}));",
  ].join("\n");
  const hits = by(scanSource(HOOK_FILE, src), RENDER);
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /in Box;/);
});

test("lowercase helper is not a component", () => {
  const src = "function helper() { ctx.eventController.getState() }";
  assert.deepEqual(by(scanSource(HOOK_FILE, src), RENDER), []);
});

test("getLocation and getHydrationSnapshot in a render body are flagged", () => {
  const src = [
    "export function usePathname() {",
    "  const a = ctx.getLocation();",
    "  const b = ctx.eventController.getHydrationSnapshot();",
    "  return a + b;",
    "}",
  ].join("\n");
  const hits = by(scanSource(HOOK_FILE, src), RENDER);
  assert.deepEqual(
    hits.map((h) => h.line),
    [2, 3],
  );
});

test("getHydrationSnapshot in a lazy useState/useReducer initializer is exempt", () => {
  const src = [
    "export function useX() {",
    "  const [a] = useState(() => ctx.eventController.getHydrationSnapshot());",
    "  const [b] = useReducer(r, null, () => ctx.getLocation());",
    "  return [a, b];",
    "}",
  ].join("\n");
  assert.deepEqual(by(scanSource(HOOK_FILE, src), RENDER), []);
});

test("same text outside rule-4 scope yields no rule-4 hits", () => {
  const src =
    "function useLoaderInternal() { return ctx.getHydrationSnapshot(); }";
  for (const f of [
    "packages/rangojs-router/src/browser/event-controller.ts",
    "packages/rangojs-router/src/browser/react/__tests__/x.ts",
    "packages/rangojs-router/src/browser/react/use-x.test.ts",
  ]) {
    assert.deepEqual(by(scanSource(f, src), RENDER), [], f);
  }
});

test("object keys, method names and type members named like the hook are not references", () => {
  const src = [
    "const a = { useSyncExternalStore: 1 };",
    "const b = { useSyncExternalStore() {} };",
    "class C { useSyncExternalStore() {} }",
    "interface I { useSyncExternalStore: () => void }",
  ].join("\n");
  assert.deepEqual(by(scanSource("packages/a/x.ts", src), HOOK), []);
});

test("shorthand property and destructuring from React are references", () => {
  const src = [
    "const a = { useSyncExternalStore };",
    "const { useSyncExternalStore: u } = React;",
  ].join("\n");
  assert.equal(by(scanSource("packages/a/x.ts", src), HOOK).length, 2);
});

test("two references on one line are both reported", () => {
  const src = "const a = [useSyncExternalStore, React.useSyncExternalStore];";
  const hits = by(scanSource("packages/a/x.ts", src), HOOK);
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((h) => h.line),
    [1, 1],
  );
});

test(".mts and .cts sources are scanned", () => {
  for (const f of ["packages/a/x.mts", "packages/a/x.cts"]) {
    assert.equal(
      by(scanSource(f, "useSyncExternalStore(a, b);"), HOOK).length,
      1,
      f,
    );
  }
});

const STORE_LIBS = [
  "zustand",
  "zustand/vanilla",
  "jotai",
  "jotai/utils",
  "valtio",
  "redux",
  "@reduxjs/toolkit",
  "react-redux",
  "mobx",
  "mobx-react",
  "mobx-react-lite",
  "nanostores",
  "@nanostores/react",
  "@nanostores/persistent",
  "effector",
  "effector-react",
  "recoil",
  "@tanstack/store",
  "@tanstack/react-store",
  "@xstate/store",
  "@legendapp/state",
  "@legendapp/state/react",
];

test("store libraries are reported for import, re-export, import(), require() and import-equals", () => {
  for (const lib of STORE_LIBS) {
    const src = [
      `import { x } from "${lib}";`,
      `export { y } from "${lib}";`,
      `export * from "${lib}";`,
      `const a = await import("${lib}");`,
      `const b = require("${lib}");`,
      `import c = require("${lib}");`,
    ].join("\n");
    const hits = by(scanSource("packages/a/x.ts", src), PKG);
    assert.deepEqual(
      hits.map((h) => h.line),
      [1, 2, 3, 4, 5, 6],
      lib,
    );
  }
});

test("lookalike package names are not flagged", () => {
  const src = [
    'import a from "redux-saga";',
    'import b from "jotai-lookalike";',
    'import c from "@tanstack/query-core";',
    'import d from "@nanostoresx/y";',
  ].join("\n");
  assert.deepEqual(by(scanSource("packages/a/x.ts", src), PKG), []);
});

test("store libraries in every package.json dependency field are reported", () => {
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const text = JSON.stringify(
      { [field]: { react: "^19", jotai: "2.20.1", "@nanostores/react": "1" } },
      null,
      2,
    );
    const hits = scanPackageJson("apps/docs/package.json", text);
    assert.deepEqual(
      hits.map((h) => [h.rule, h.line]),
      [
        [DEP, 4],
        [DEP, 5],
      ],
      field,
    );
  }
});

test("scanPackageJson reports each hit on its own line, per field", () => {
  const text = [
    "{",
    '  "dependencies": {',
    '    "react": "^19",',
    '    "zustand": "5"',
    "  },",
    '  "devDependencies": {',
    '    "zustand": "5",',
    '    "jotai": "2"',
    "  }",
    "}",
  ].join("\n");
  const hits = scanPackageJson("apps/x/package.json", text);
  assert.deepEqual(
    hits.map((h) => [h.rule, h.line, h.message]),
    [
      [DEP, 4, "dependencies lists zustand"],
      [DEP, 7, "devDependencies lists zustand"],
      [DEP, 8, "devDependencies lists jotai"],
    ],
  );
});

test("rule 4 walks IIFEs and useMemo factories, not lazy initializers or callbacks", () => {
  const flagged = [
    "export function useA() {",
    "  const l = (() => ctx.eventController.getState())();",
    "  return l;",
    "}",
  ].join("\n");
  assert.equal(by(scanSource(HOOK_FILE, flagged), RENDER).length, 1);

  const fnExpr = [
    "export function useA() {",
    "  return (function () { return ctx.eventController.getState(); })();",
    "}",
  ].join("\n");
  assert.equal(by(scanSource(HOOK_FILE, fnExpr), RENDER).length, 1);

  const memo = [
    "export function useB(x) {",
    "  return useMemo(() => ctx.eventController.getState(), [x]);",
    "}",
  ].join("\n");
  assert.equal(by(scanSource(HOOK_FILE, memo), RENDER).length, 1);

  const reactMemo = [
    "export function useB(x) {",
    "  return React.useMemo(() => { return ctx.getLocation(); }, [x]);",
    "}",
  ].join("\n");
  assert.equal(by(scanSource(HOOK_FILE, reactMemo), RENDER).length, 1);

  const exempt = [
    "export function useC() {",
    "  const [a] = useState(() => ctx.eventController.getState());",
    "  const [b] = useReducer((s) => s, 0, () => ctx.eventController.getState());",
    "  const cb = useCallback(() => ctx.eventController.getState(), []);",
    "  useEffect(() => { ctx.eventController.getState(); }, []);",
    "  useLayoutEffect(() => { ctx.eventController.getState(); }, []);",
    "  const h = () => ctx.eventController.getState();",
    "  startTransition(() => { ctx.eventController.getState(); });",
    "  return [a, b, cb, h];",
    "}",
  ].join("\n");
  assert.equal(by(scanSource(HOOK_FILE, exempt), RENDER).length, 0);
});

test("rule 4 walks array-iteration callbacks, unless the parent is exempt", () => {
  for (const method of [
    "map",
    "filter",
    "reduce",
    "reduceRight",
    "forEach",
    "flatMap",
    "some",
    "every",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
  ]) {
    const src = `export function Comp({ ctx, items }) {\n  return items.${method}(() => ctx.eventController.getState());\n}`;
    assert.equal(by(scanSource(HOOK_FILE, src), RENDER).length, 1, method);
  }
  const exempt = [
    "export function useD({ ctx, items }) {",
    "  useEffect(() => { items.map(() => ctx.eventController.getState()); }, []);",
    "  const [a] = useState(() => items.map(() => ctx.eventController.getState()));",
    "  const cb = useCallback(() => items.forEach(() => ctx.eventController.getState()), []);",
    "  const h = () => items.filter(() => ctx.eventController.getState());",
    "  return [a, cb, h];",
    "}",
  ].join("\n");
  assert.equal(by(scanSource(HOOK_FILE, exempt), RENDER).length, 0);
});
