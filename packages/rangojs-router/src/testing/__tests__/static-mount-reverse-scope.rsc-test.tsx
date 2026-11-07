/**
 * A Static() mount's `.name` links resolve in the mount's own include scope, in
 * a build exactly as in dev.
 *
 * The bake renders a Static handler outside the request's evaluation scope, so
 * it takes the mount's scope from the StaticMount the DSL recorded
 * (stampStaticDefScope -> StaticMount.reverseScope) and resolves `.name`
 * through it, the same `scopeReverse` a live layout or slot handler gets via
 * withReverseScope. It used to read the mount's route name as if it were a
 * route: the last dot segment of a nested include's prefix was dropped (so
 * `acme.admin` linked into `acme`, or threw "Unknown route" when nothing
 * matched) and a root-scope mount had no prefix at all, so `ctx.reverse(".name")`
 * threw at build time while dev resolved it.
 *
 * Every case asserts both halves: the href the live handler renders (dev) and
 * the href the baked artifact carries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { Static, type StaticHandlerDefinition } from "../../static-handler.js";
import type { UrlPatterns } from "../../urls/pattern-types.js";
import { generateManifestFull } from "../../build/generate-manifest.js";
import { renderStaticHandlers } from "../../vite/discovery/prerender-collection.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const ROUTER_ID = "mount-scope";
const MODULE_ID = "/app/mount-scope.tsx";

/** The link text the handler renders: `link:<href>`. */
function linkText(href: string): string {
  return `link:${href}`;
}

function staticDef(id: string): StaticHandlerDefinition {
  return Static(
    (ctx) => <p>{linkText(ctx.reverse(".settings"))}</p>,
    undefined,
    id,
  ) as StaticHandlerDefinition;
}

interface Case {
  patterns: UrlPatterns;
  /** The route name the bake resolves against. */
  routeNames: Record<string, string>;
  /** The URL a visitor opens, and the href dev resolves from it. */
  url: string;
  href: string;
  /** A link into the enclosing module, which a dropped prefix would produce. */
  wrongHref?: string;
}

/**
 * The href dev renders for the mount, through the same production serve path a
 * document request takes.
 */
async function liveHref(c: Case): Promise<string> {
  const router = createRouter({}).routes(c.patterns);
  const result = await serveShellRequest(router, c.url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  expect(result.response.status).toBe(200);
  const flight = result.flight ?? "";
  expect(flight).toContain(linkText(c.href));
  return c.href;
}

/** The href the build bakes into the mount's artifact, keyed by its mount. */
async function bakedHref(
  c: Case,
  def: StaticHandlerDefinition,
): Promise<string> {
  const router = createRouter({
    id: ROUTER_ID,
    $$routeNames: c.routeNames,
  } as never).routes(c.patterns as never);
  await generateManifestFull(c.patterns as never, 0, { routerId: ROUTER_ID });

  const projectRoot = mkdtempSync(join(tmpdir(), "rango-mount-scope-"));
  const state: any = {
    opts: { enableBuildPrerender: true },
    isBuildMode: true,
    resolvedStaticModules: new Map([[MODULE_ID, ["Shared"]]]),
    projectRoot,
    resolvedBuildEnv: undefined,
    buildData: [],
    staticManifestEntries: null,
  };
  const exports = { Shared: def };
  await renderStaticHandlers(
    state,
    { runner: { import: async () => exports } },
    new Map([[ROUTER_ID, router]]),
  );

  const entries = state.staticManifestEntries ?? {};
  expect(Object.keys(entries)).toHaveLength(1);
  const source = readFileSync(
    join(
      projectRoot,
      "node_modules/.rangojs-router-build/rsc-assets",
      Object.values(entries)[0] as string,
    ),
    "utf-8",
  );
  expect(source).toContain(linkText(c.href));
  if (c.wrongHref) expect(source).not.toContain(linkText(c.wrongHref));
  return c.href;
}

beforeEach(() => resetShellTestState());

describe("a Static() mount bakes the links dev renders", () => {
  it("a layout mounted at root scope links into the root map", async () => {
    const nav = staticDef("test#RootMountNav");
    const c: Case = {
      patterns: urls(({ path, layout }) => [
        layout(nav as never, () => [
          path("/settings", () => null, { name: "settings" }),
        ]),
      ]),
      routeNames: { settings: "/settings" },
      url: "/settings",
      href: "/settings",
    };

    // Bake first: the live router's own DSL evaluation would record a mount
    // without a router id, and the collector bakes one artifact per mount key.
    expect(await bakedHref(c, nav)).toBe("/settings");
    expect(await liveHref(c)).toBe("/settings");
  });

  it("a layout mounted in a nested include links into that include", async () => {
    const nav = staticDef("test#NestedMountNav");
    const inner = urls(({ path, layout }) => [
      layout(nav as never, () => [
        path("/settings", () => null, { name: "settings" }),
      ]),
    ]);
    const outer = urls(({ include }) => [
      include("/admin", inner, { name: "admin" }),
    ]);
    const c: Case = {
      patterns: urls(({ include }) => [
        include("/acme", outer, { name: "acme" }),
      ]),
      routeNames: { "acme.admin.settings": "/acme/admin/settings" },
      url: "/acme/admin/settings",
      href: "/acme/admin/settings",
      // Dropping the last prefix segment resolves the parent module's route.
      wrongHref: "/acme/settings",
    };

    expect(await bakedHref(c, nav)).toBe("/acme/admin/settings");
    expect(await liveHref(c)).toBe("/acme/admin/settings");
  });

  it("a slot mounted in a nested include links into that include", async () => {
    const aside = staticDef("test#NestedMountAside");
    const inner = urls(({ path, parallel }) => [
      path(
        "/settings",
        () => null,
        { name: "settings" },
        () => [parallel({ "@aside": aside as never })],
      ),
    ]);
    const outer = urls(({ include }) => [
      include("/admin", inner, { name: "admin" }),
    ]);
    const c: Case = {
      patterns: urls(({ include }) => [
        include("/acme", outer, { name: "acme" }),
      ]),
      routeNames: { "acme.admin.settings": "/acme/admin/settings" },
      url: "/acme/admin/settings",
      href: "/acme/admin/settings",
      wrongHref: "/acme/settings",
    };

    expect(await bakedHref(c, aside)).toBe("/acme/admin/settings");
    expect(await liveHref(c)).toBe("/acme/admin/settings");
  });

  it("control: a layout mounted in one named include links into it", async () => {
    const nav = staticDef("test#OneMountNav");
    const moduleA = urls(({ path, layout }) => [
      layout(nav as never, () => [
        path("/settings", () => null, { name: "settings" }),
      ]),
    ]);
    const c: Case = {
      patterns: urls(({ include }) => [include("/a", moduleA, { name: "a" })]),
      routeNames: { "a.settings": "/a/settings" },
      url: "/a/settings",
      href: "/a/settings",
    };

    expect(await bakedHref(c, nav)).toBe("/a/settings");
    expect(await liveHref(c)).toBe("/a/settings");
  });
});
