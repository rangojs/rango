/**
 * The build's Static() collector (renderStaticHandlers) bakes one artifact
 * per mount of a definition, and each mount's entry serves its own. One
 * Static() layout, parallel slot and route, exported once and mounted in the
 * includes "a", "b" and "outer.inner", must link in each mount's module in a
 * build exactly as they do live: `.settings` from /a resolves /a/settings.
 *
 * The router is evaluated as discovery evaluates it (generateManifestFull per
 * urlpatterns mount), the collector runs on its real code with a stub runner
 * import and a temporary project root, and the staged artifacts are served
 * through the production static store (globalThis.__STATIC_MANIFEST) by the
 * router's own fetch handler.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);

// Installs the SSR stub router.fetch renders documents with: a document's
// body is its Flight payload.
import "../../../testing/serve-shell-request.js";
import { createRouter, Static, urls } from "../../../index.rsc.js";
import { generateManifestFull } from "../../../build/generate-manifest.js";
import { renderStaticHandlers } from "../prerender-collection.js";
import { RANGO_BUILD_DIR } from "../../utils/prerender-utils.js";

const calls = { nav: 0, side: 0, page: 0 };
const LINKS = ["/a/settings", "/b/settings", "/outer/inner/settings"];

const SharedNav = Static(
  (ctx) => {
    calls.nav++;
    return <nav>{`nav:${ctx.reverse(".settings")}`}</nav>;
  },
  undefined,
  "static-mount-bake#SharedNav",
);
const SharedSide = Static(
  (ctx) => {
    calls.side++;
    return <aside>{`side:${ctx.reverse(".settings")}`}</aside>;
  },
  undefined,
  "static-mount-bake#SharedSide",
);
const SharedPage = Static(
  (ctx) => {
    calls.page++;
    return <main>{`page:${ctx.reverse(".settings")}`}</main>;
  },
  undefined,
  "static-mount-bake#SharedPage",
);

const module = urls(({ path, layout, parallel }) => [
  layout(SharedNav, () => [
    parallel({ "@side": SharedSide }),
    path("/settings", () => <p>settings</p>, { name: "settings" }),
    path("/page", SharedPage, { name: "page" }),
  ]),
]);
const nested = urls(({ include }) => [
  include("/inner", module, { name: "inner" }),
]);

// The build injects the generated route names ($$routeNames), so a build-time
// reverse() reaches routes in includes no request has evaluated yet.
const $$routeNames = Object.fromEntries(
  ["a", "b", "outer.inner"].flatMap((prefix) => {
    const base = `/${prefix.replace(".", "/")}`;
    return [
      [`${prefix}.settings`, `${base}/settings`],
      [`${prefix}.page`, `${base}/page`],
    ];
  }),
);

const router = createRouter({ id: "static-mount-bake", $$routeNames }).routes(
  urls(({ include }) => [
    include("/a", module, { name: "a" }),
    include("/b", module, { name: "b" }),
    include("/outer", nested, { name: "outer" }),
  ]),
);

let projectRoot: string;
let state: any;

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "rango-static-mount-bake-"));
  const internal = router as any;
  // Discovery: every include body evaluates, recording every mount.
  for (const [index, mount] of internal.__urlpatternMounts.entries()) {
    await generateManifestFull(mount.patterns, index, { routerId: router.id });
  }
  state = {
    opts: { enableBuildPrerender: true },
    isBuildMode: true,
    projectRoot,
    buildData: [],
    resolvedStaticModules: new Map([
      ["static-mount-bake.tsx", ["SharedNav", "SharedSide", "SharedPage"]],
    ]),
  };
  await renderStaticHandlers(
    state,
    {
      runner: { import: async () => ({ SharedNav, SharedSide, SharedPage }) },
    },
    new Map([[router.id, router]]),
  );
  // What bundle-postprocess.ts writes: key -> import of the staged module.
  const assets = join(projectRoot, RANGO_BUILD_DIR, "rsc-assets");
  globalThis.__STATIC_MANIFEST = Object.fromEntries(
    Object.entries(state.staticManifestEntries ?? {}).map(([key, file]) => {
      const source = readFileSync(join(assets, file as string), "utf-8");
      const value = JSON.parse(
        source.slice("export default ".length, source.lastIndexOf(";")),
      );
      return [key, async () => ({ default: value })];
    }),
  );
});

afterAll(() => {
  globalThis.__STATIC_MANIFEST = undefined;
  rmSync(projectRoot, { recursive: true, force: true });
});

async function serve(pathname: string): Promise<string> {
  const response = await router.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
  );
  return response.text();
}

describe("Static() collector: one artifact per mount", () => {
  it("bakes each mount of a layout, slot and route once, in its own scope", () => {
    const baked = Object.keys(state.staticManifestEntries ?? {});
    expect(baked.filter((key) => key.startsWith(SharedNav.$$id))).toHaveLength(
      3,
    );
    expect(baked.filter((key) => key.startsWith(SharedSide.$$id))).toHaveLength(
      3,
    );
    expect(baked.filter((key) => key.startsWith(SharedPage.$$id))).toHaveLength(
      3,
    );
  });

  it.each([
    ["/a/settings", "/a/settings"],
    ["/b/settings", "/b/settings"],
    ["/outer/inner/settings", "/outer/inner/settings"],
  ])(
    "%s serves the layout and slot artifacts of its own mount",
    async (pathname, link) => {
      const before = { ...calls };
      const body = await serve(pathname);
      expect(body).toContain(`nav:${link}`);
      expect(body).toContain(`side:${link}`);
      for (const other of LINKS.filter((l) => l !== link)) {
        expect(body).not.toContain(`:${other}`);
      }
      // Served from the artifact: no Static() handler ran for the request.
      expect(calls).toEqual(before);
    },
  );

  it.each([
    ["/a/page", "/a/settings"],
    ["/b/page", "/b/settings"],
    ["/outer/inner/page", "/outer/inner/settings"],
  ])(
    "%s serves the route artifact of its own mount",
    async (pathname, link) => {
      const before = { ...calls };
      const body = await serve(pathname);
      expect(body).toContain(`page:${link}`);
      expect(body).toContain(`nav:${link}`);
      expect(calls).toEqual(before);
    },
  );
});
