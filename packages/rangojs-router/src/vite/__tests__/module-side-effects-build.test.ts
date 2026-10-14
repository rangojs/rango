/**
 * The plugin's modules that a build reaches only through bare imports keep
 * their side effects: real `vite build` runs of the two-app host fixture,
 * then document requests against the built server.
 *
 * A bundler drops a bare import of a module it believes has no side effects.
 * Each of these modules declares them from its own `load` (which outranks
 * both the app's package.json and the build's treeshake options):
 *
 * - `<file>?rango-revalidate` (clientUrls() revalidate() predicates): the RSC
 *   proxy of a group imports the group's module, which imports the module of
 *   each component file discovery assigned the group. The ids name the app's
 *   own files, so its package.json `"sideEffects": false` covered them and the
 *   build dropped the chain: no chunk called registerClientUrlRevalidators,
 *   and every route of the group answered 404 with "has no server
 *   registration" (#1149). Dev never tree-shakes, so only a deployed build
 *   showed it.
 * - virtual:rsc-router/routes-manifest and virtual:rsc-router/loader-manifest,
 *   imported by the RSC entry: virtual ids have no package.json, but a build
 *   whose treeshake.moduleSideEffects is false dropped both, and the server
 *   failed at startup ("could not resolve the server projection").
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFixture,
  createFixtureWorkspace,
  requestBuiltFixture,
  type FixtureBuild,
  type FixtureScenario,
} from "./helpers/build-cache-versions-fixture.js";

/** In the predicates' source only: the RSC output has it iff they register. */
const GROUP_TAG = "lazy-group-predicate";
const COMPONENT_TAG = "component-use-predicate";

const edits: FixtureScenario["edits"] = {
  // A plain module the predicates import.
  "src/apps/b/keep.ts": [
    `export function keep(params: Record<string, string | undefined>, tag: string): boolean {`,
    `  return params.id !== tag;`,
    `}`,
    ``,
  ].join("\n"),
  // A group with a predicate of its own, included lazily.
  "src/apps/b/group.tsx": [
    `"use client";`,
    `import { clientUrls, useLoader } from "@rangojs/router/client";`,
    `import { ItemLoader } from "./group.loader.js";`,
    `import { keep } from "./keep.js";`,
    ``,
    `function Item() {`,
    `  const { data } = useLoader(ItemLoader);`,
    `  return <p>{data}</p>;`,
    `}`,
    ``,
    `export default clientUrls(({ path, loader, revalidate }) => [`,
    `  path("/c/:id", Item, { name: "item" }, () => [`,
    `    loader(ItemLoader, () => [`,
    `      revalidate(({ nextParams }) => keep(nextParams, "${GROUP_TAG}")),`,
    `    ]),`,
    `  ]),`,
    `]);`,
    ``,
  ].join("\n"),
  "src/apps/b/group.loader.ts": [
    `import { createLoader } from "@rangojs/router";`,
    ``,
    `export const ItemLoader = createLoader(async (ctx) => \`item:\${ctx.params.id}\`);`,
    ``,
  ].join("\n"),
  // A component whose .use holds the predicate. The group that renders it
  // declares none, so the group's module only imports this module's.
  "src/apps/b/first.page.tsx": [
    `import { loader, revalidate, useLoader } from "@rangojs/router/client";`,
    `import { FirstLoader } from "./pages.loader.js";`,
    `import { keep } from "./keep.js";`,
    ``,
    `export function First() {`,
    `  const { data } = useLoader(FirstLoader);`,
    `  return <p>{data}</p>;`,
    `}`,
    `First.use = () => [`,
    `  loader(FirstLoader, () => [`,
    `    revalidate(({ nextParams }) => keep(nextParams, "${COMPONENT_TAG}")),`,
    `  ]),`,
    `];`,
    ``,
  ].join("\n"),
  "src/apps/b/pages.tsx": [
    `"use client";`,
    `import { clientUrls } from "@rangojs/router/client";`,
    `import { First } from "./first.page.js";`,
    ``,
    `export default clientUrls(({ path }) => [`,
    `  path("/first", First, { name: "first" }),`,
    `]);`,
    ``,
  ].join("\n"),
  "src/apps/b/urls.tsx": (source) => {
    const anchor = `  include("/pages"`;
    if (!source.includes(anchor)) throw new Error(`fixture edit: no ${anchor}`);
    return source.replace(
      anchor,
      `  include("/group", () => import("./group.js"), { name: "group" }),\n${anchor}`,
    );
  },
};

function rscChunks(root: string): string[] {
  const dir = join(root, "dist/rsc");
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(dir, file), "utf-8"));
}

/** Whether some RSC chunk calls `name` with an argument starting `args`. */
function calls(build: FixtureBuild, name: string, args: string): boolean {
  const call = new RegExp(`\\b${name}[\\w$]*\\(${args}`);
  return rscChunks(build.root).some((chunk) => call.test(chunk));
}

/** Whether a registerClientUrlRevalidators call holds the predicate tagged `tag`. */
const registers = (build: FixtureBuild, tag: string) =>
  calls(build, "registerClientUrlRevalidators", `\\{[^;]*?"${tag}"`);

describe("plugin modules a build reaches only through bare imports", () => {
  const workspace = createFixtureWorkspace();
  let appSideEffectsFalse: FixtureBuild;
  let treeshakeSideEffectsFalse: FixtureBuild;

  beforeAll(async () => {
    [appSideEffectsFalse, treeshakeSideEffectsFalse] = await Promise.all([
      buildFixture(join(workspace.dir, "side-effects-false"), {
        edits: {
          ...edits,
          "package.json": `{ "type": "module", "sideEffects": false }\n`,
        },
      }),
      buildFixture(join(workspace.dir, "treeshake-false"), {
        edits: { ...edits, "package.json": `{ "type": "module" }\n` },
        viteConfig: `build: { rolldownOptions: { treeshake: { moduleSideEffects: false } } }`,
      }),
    ]);
  }, 240_000);

  afterAll(() => workspace.cleanup());

  describe('an app whose package.json says "sideEffects": false', () => {
    it("the server build registers the revalidate() predicates of a group and of a component's .use", () => {
      expect(registers(appSideEffectsFalse, GROUP_TAG)).toBe(true);
      expect(registers(appSideEffectsFalse, COMPONENT_TAG)).toBe(true);
    });

    it("a route of the lazily included group and one whose component's .use holds the predicate answer 200", async () => {
      const [item, first] = await requestBuiltFixture(
        appSideEffectsFalse.root,
        ["http://b.localhost/group/c/x", "http://b.localhost/pages/first"],
      );
      expect([item!.status, item!.body.includes("item:x")]).toEqual([
        200,
        true,
      ]);
      expect([first!.status, first!.body.includes("<p>first</p>")]).toEqual([
        200,
        true,
      ]);
    }, 60_000);
  });

  it("a build whose treeshake.moduleSideEffects is false keeps the routes manifest, the loader manifest and the predicate registrations", () => {
    const build = treeshakeSideEffectsFalse;
    expect(calls(build, "setClientUrlProjection", `"`)).toBe(true);
    expect(calls(build, "setLoaderImports", `\\{`)).toBe(true);
    expect(registers(build, GROUP_TAG)).toBe(true);
    expect(registers(build, COMPONENT_TAG)).toBe(true);
  });
});
