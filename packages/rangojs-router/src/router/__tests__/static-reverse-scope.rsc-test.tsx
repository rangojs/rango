/**
 * One Static() definition mounted in two include() scopes bakes one artifact
 * per mount, each resolving `.name` in its own scope.
 *
 * The static store is keyed by the entry's `staticHandlerId`. Keyed by the
 * definition's `$$id` alone, a definition mounted twice had ONE artifact and
 * both mounts read it — baked in the LAST mount's scope, so the other mount's
 * links pointed into the last mount's module. The collector now bakes once per
 * recorded mount (StaticMount) under that mount's key.
 *
 * The DSL half of the contract (which key each entry carries) is pinned in
 * route-definition/__tests__/static-mount-scope.test.ts. Real Flight: the
 * artifact is what the build ships, so the links must be asserted in the
 * encoded payload.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc/server", async () => {
  const RSD =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge");
  // Resolves any "use client" reference (the router's implicit layouts render
  // the client Outlet): `$$id` is `${id}#${name}`.
  const clientManifest = new Proxy(
    {},
    {
      get: (_target, key) =>
        typeof key === "string"
          ? { id: key.split("#")[0], chunks: [], name: key.split("#")[1] }
          : undefined,
    },
  );
  return {
    createTemporaryReferenceSet: () => new WeakMap(),
    renderToReadableStream: (value: unknown, options?: object) =>
      RSD.renderToReadableStream(value, clientManifest, options),
  };
});
vi.mock("@vitejs/plugin-rsc/rsc/client", async () => {
  await import("../../testing/internal/flight-client-globals.js");
  const { createFromReadableStream } =
    await import("@vitejs/plugin-rsc/react/browser");
  return {
    createFromReadableStream: (stream: ReadableStream<Uint8Array>) =>
      createFromReadableStream(stream),
  };
});

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { Static, type StaticHandlerDefinition } from "../../static-handler.js";
import type { UrlPatterns } from "../../urls/pattern-types.js";
import { generateManifestFull } from "../../build/generate-manifest.js";
import { renderStaticHandlers } from "../../vite/discovery/prerender-collection.js";

/** A fresh definition per test: mount records accumulate on the definition. */
function staticDef(id: string, testId: string): StaticHandlerDefinition {
  return Static(
    (ctx: any) => (
      <a data-testid={testId} href={ctx.reverse(".settings")}>
        {testId}
      </a>
    ),
    undefined,
    id,
  ) as StaticHandlerDefinition;
}

const ROUTER_ID = "two-mount";
const MODULE_ID = "/app/shared-nav.tsx";

function includePatterns(defs: {
  nav: StaticHandlerDefinition;
  aside: StaticHandlerDefinition;
}) {
  const moduleA = urls(({ path, layout, parallel }) => [
    layout(defs.nav as never, () => [
      path(
        "/settings",
        () => null,
        { name: "settings" },
        () => [parallel({ "@aside": defs.aside as never })],
      ),
    ]),
  ]);
  const moduleB = urls(({ path, layout, parallel }) => [
    layout(defs.nav as never, () => [
      path(
        "/settings",
        () => null,
        { name: "settings" },
        () => [parallel({ "@aside": defs.aside as never })],
      ),
    ]),
  ]);
  return urls(({ include }) => [
    include("/a", moduleA, { name: "a" }),
    include("/b", moduleB, { name: "b" }),
  ]);
}

interface Baked {
  /** Static-manifest key -> the staged asset module's source. */
  assets: Record<string, string>;
  buildDataKeys: string[];
}

/**
 * Run the build's static collector exactly as discovery does: the router
 * resolves reverse() against the full route map (seeded from the generated
 * named-routes file in a real app), and the collector imports the module that
 * exports the definitions.
 */
async function bake(
  patterns: UrlPatterns,
  exports: Record<string, unknown>,
): Promise<Baked> {
  const router = createRouter({
    id: ROUTER_ID,
    $$routeNames: {
      "a.settings": "/a/settings",
      "b.settings": "/b/settings",
    },
  } as never).routes(patterns as never);
  // Discovery evaluates include() children here, which is where each mount's
  // scope is stamped on the definition.
  await generateManifestFull(patterns as never, 0, { routerId: ROUTER_ID });

  const projectRoot = mkdtempSync(join(tmpdir(), "rango-static-mount-"));
  const state: any = {
    opts: { enableBuildPrerender: true },
    isBuildMode: true,
    resolvedStaticModules: new Map([[MODULE_ID, Object.keys(exports)]]),
    projectRoot,
    resolvedBuildEnv: undefined,
    buildData: [],
    staticManifestEntries: null,
  };
  const rscEnv = { runner: { import: async () => exports } };
  await renderStaticHandlers(state, rscEnv, new Map([[ROUTER_ID, router]]));

  const entries = state.staticManifestEntries ?? {};
  const assets: Record<string, string> = {};
  for (const [key, fileName] of Object.entries(entries)) {
    assets[key] = readFileSync(
      join(
        projectRoot,
        "node_modules/.rangojs-router-build/rsc-assets",
        fileName as string,
      ),
      "utf-8",
    );
  }
  return {
    assets,
    buildDataKeys: state.buildData.map((record: any) => record.key),
  };
}

describe("a Static() def mounted twice", () => {
  it("bakes one artifact per mount, each resolving its own include scope", async () => {
    const nav = staticDef("test#SharedNav", "shared-nav");
    const aside = staticDef("test#SharedAside", "shared-aside");
    const { assets, buildDataKeys } = await bake(
      includePatterns({ nav, aside }),
      { SharedNav: nav, SharedAside: aside },
    );

    const keyOf = (def: StaticHandlerDefinition, scope: string) =>
      `test#${def.$$id.split("#")[1]}::${ROUTER_ID}::${scope}::scoped`;
    const expectedKeys = ["a", "b"].flatMap((scope) => [
      keyOf(nav, scope),
      keyOf(aside, scope),
    ]);
    expect(Object.keys(assets).sort()).toEqual(expectedKeys.sort());
    expect(buildDataKeys.sort()).toEqual(expectedKeys.sort());

    // Each mount's links resolve in its own scope, layout and slot alike.
    expect(assets[keyOf(nav, "a")]).toContain("/a/settings");
    expect(assets[keyOf(nav, "b")]).toContain("/b/settings");
    expect(assets[keyOf(aside, "a")]).toContain("/a/settings");
    expect(assets[keyOf(aside, "b")]).toContain("/b/settings");
    // A mount that resolved the other scope's route would be a silent wrong
    // link, so assert the absence too.
    expect(assets[keyOf(nav, "a")]).not.toContain("/b/settings");
    expect(assets[keyOf(nav, "b")]).not.toContain("/a/settings");
  });

  it("control: a definition mounted once still bakes a single artifact", async () => {
    const nav = staticDef("test#SharedNav", "shared-nav");
    // Only include "a" mounts this definition.
    const moduleA = urls(({ path, layout }) => [
      layout(nav as never, () => [
        path("/settings", () => null, { name: "settings" }),
      ]),
    ]);
    const patterns = urls(({ include }) => [
      include("/a", moduleA, { name: "a" }),
    ]);

    const { assets } = await bake(patterns, { SharedNav: nav });

    expect(Object.keys(assets)).toEqual([
      `test#SharedNav::${ROUTER_ID}::a::scoped`,
    ]);
    expect(assets[`test#SharedNav::${ROUTER_ID}::a::scoped`]).toContain(
      "/a/settings",
    );
  });
});
