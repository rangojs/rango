/**
 * The request-time manifest rebuild (router/manifest.ts) re-evaluates a lazy
 * include's DSL outside build discovery, so it must restore the include's
 * router id: path() scopes what it registers per router (route root scope and
 * search schemas) and a Static() mount composes its artifact key from it.
 *
 * Without the seed, a rebuilt Static mount composed its key with no router
 * (`test#SharedNav::::mountA`) and never matched the artifact the build wrote
 * under `test#SharedNav::<router>::mountA`, so a lazy include's Static layout
 * served no artifact at all. The build-side keys are pinned in
 * route-definition/__tests__/static-mount-scope.test.ts and
 * router/__tests__/static-reverse-scope.rsc-test.tsx.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { urls } from "../../urls.js";
import { Static, type StaticHandlerDefinition } from "../../static-handler.js";
import type { UrlPatterns } from "../../urls/pattern-types.js";
import { generateManifestFull } from "../../build/generate-manifest.js";
import { RangoContext, type EntryData } from "../../server/context.js";
import {
  clearAllRouterData,
  getSearchSchema,
  isRouteRootScoped,
} from "../../route-map-builder.js";
import type { LazyIncludeContext, RouteEntry } from "../../types.js";
import { clearManifestCache, loadManifest } from "../manifest.js";
import { makeSyntheticRoot } from "../../__tests__/helpers/synthetic-root.js";

const ROUTER_ID = "seed-router";
const OTHER_ROUTER_ID = "seed-other-router";

/**
 * The lazy RouteEntry router.ts registers for an include() mount, evaluated
 * later by loadManifest on the request that matches one of its routes.
 */
function lazyEntry(
  patterns: UrlPatterns<any, any, any>,
  context: Omit<LazyIncludeContext, "urlPrefix" | "parent"> & {
    urlPrefix?: string;
  },
  entryRouterId?: string,
): RouteEntry {
  return {
    prefix: "",
    staticPrefix: "",
    routes: {},
    handler: patterns.handler,
    mountIndex: 1,
    ...(entryRouterId ? { routerId: entryRouterId } : {}),
    lazy: true,
    lazyEvaluated: false,
    lazyPatterns: patterns,
    lazyContext: {
      urlPrefix: "",
      parent: makeSyntheticRoot(),
      counters: {},
      ...context,
    },
  } as unknown as RouteEntry;
}

/** Run the rebuild the way a request does, inside the root store. */
async function rebuild(
  entry: RouteEntry,
  routeKey: string,
): Promise<EntryData> {
  let rebuilt: EntryData | undefined;
  await RangoContext.run(
    {
      manifest: new Map(),
      patterns: new Map(),
      patternsByPrefix: new Map(),
      trailingSlash: new Map(),
      namespace: "root",
      parent: makeSyntheticRoot(),
      counters: {},
      mountIndex: 0,
    },
    async () => {
      rebuilt = await loadManifest(entry, routeKey, "/");
    },
  );
  return rebuilt!;
}

/** The Static artifact key the route's nearest ancestor layout carries. */
function staticHandlerIdOf(route: EntryData): string | undefined {
  for (let entry: EntryData | null = route; entry; entry = entry.parent) {
    const id = (entry as { staticHandlerId?: string }).staticHandlerId;
    if (id !== undefined) return id;
  }
  return undefined;
}

function staticNavPatterns(
  def: StaticHandlerDefinition,
  routeName: string,
): UrlPatterns {
  return urls(({ path, layout }) => [
    layout(def as never, () => [
      path("/settings", () => null, { name: routeName }),
    ]),
  ]);
}

describe("a lazy manifest rebuild restores its include's router id", () => {
  beforeEach(() => {
    clearAllRouterData();
    clearManifestCache();
  });

  it("keys a rebuilt Static mount exactly as the build keyed it", async () => {
    const SharedNav = Static(
      () => null,
      undefined,
      "test#SeedNav",
    ) as StaticHandlerDefinition;
    const moduleA = staticNavPatterns(SharedNav, "settings");
    const patterns = urls(({ include }) => [
      include("/mount-a", moduleA, { name: "mountA" }),
    ]);

    // Build discovery stamps the mount and the collector bakes it under this key.
    await generateManifestFull(patterns as never, 0, { routerId: ROUTER_ID });
    const buildKey = `test#SeedNav::${ROUTER_ID}::mountA`;
    expect(SharedNav.$$staticMounts?.map((mount) => mount.key)).toContain(
      buildKey,
    );

    // The same include, rebuilt per request: the entry carries the router
    // (router.ts) and the captured context repeats it (include()).
    const rebuilt = await rebuild(
      lazyEntry(
        moduleA,
        { namePrefix: "mountA", rootScoped: false, routerId: ROUTER_ID },
        ROUTER_ID,
      ),
      "mountA.settings",
    );

    expect(staticHandlerIdOf(rebuilt)).toBe(buildKey);
  });

  it("falls back to the include's captured router when the entry carries none", async () => {
    const SharedNav = Static(
      () => null,
      undefined,
      "test#SeedNav",
    ) as StaticHandlerDefinition;
    const moduleA = staticNavPatterns(SharedNav, "settings");

    await generateManifestFull(
      urls(({ include }) => [include("/mount-a", moduleA, { name: "mountA" })]),
      0,
      { routerId: ROUTER_ID },
    );

    const rebuilt = await rebuild(
      lazyEntry(moduleA, {
        namePrefix: "mountA",
        rootScoped: false,
        routerId: ROUTER_ID,
      }),
      "mountA.settings",
    );

    expect(staticHandlerIdOf(rebuilt)).toBe(
      `test#SeedNav::${ROUTER_ID}::mountA`,
    );
  });

  it("registers the rebuilt route in its own router's tier", async () => {
    const moduleA = urls(({ path }) => [
      path("/settings", () => null, {
        name: "settings",
        search: { q: "string" },
      }),
    ]);
    // A named include under a transparent one. Discovery evaluates each
    // include from a root store, so the mount registers scoped (false).
    const transparent = urls(({ include }) => [
      include("/a", moduleA, { name: "mountA" }),
    ]);
    await generateManifestFull(
      urls(({ include }) => [
        include("/t", transparent, { name: "" }),
      ]) as never,
      0,
      { routerId: ROUTER_ID },
    );
    expect(isRouteRootScoped("mountA.settings", ROUTER_ID)).toBe(false);
    expect(getSearchSchema("mountA.settings", ROUTER_ID)).toEqual({
      q: "string",
    });

    // The request-time rebuild restores the captured parent scope (root) and
    // re-applies only this include's name, so it registers root-scoped. The
    // two paths disagree on this value, which is why it stays out of the
    // Static artifact key (staticArtifactKey).
    const rebuilt = await rebuild(
      lazyEntry(
        moduleA,
        {
          urlPrefix: "/t",
          namePrefix: "mountA",
          rootScoped: true,
          routerId: ROUTER_ID,
        },
        ROUTER_ID,
      ),
      "mountA.settings",
    );
    expect((rebuilt as { type?: string }).type).toBe("route");
    expect(isRouteRootScoped("mountA.settings", ROUTER_ID)).toBe(true);
    expect(getSearchSchema("mountA.settings", ROUTER_ID)).toEqual({
      q: "string",
    });

    // Another router evaluating the same route name overwrites the global
    // tier. The rebuild's per-router registration must survive it, or the
    // first router parses its search params with the other's schema.
    const otherModule = urls(({ path }) => [
      path("/settings", () => null, {
        name: "settings",
        search: { page: "number" },
      }),
    ]);
    await generateManifestFull(
      urls(({ include }) => [
        include("/mount-a", otherModule, { name: "mountA" }),
      ]) as never,
      1,
      { routerId: OTHER_ROUTER_ID },
    );

    expect(isRouteRootScoped("mountA.settings", ROUTER_ID)).toBe(true);
    expect(isRouteRootScoped("mountA.settings")).toBe(false);
    expect(getSearchSchema("mountA.settings", ROUTER_ID)).toEqual({
      q: "string",
    });
    expect(getSearchSchema("mountA.settings")).toEqual({ page: "number" });
  });
});
