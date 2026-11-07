/**
 * The build-time Static/Prerender bake resolves route names against the route
 * map discovery just generated, not the `<router>.named-routes.gen.ts` seed.
 *
 * The gen file is rewritten only after discoverRouters() returns
 * (build-discovery-phase.ts), and the bake runs inside it. A route added since
 * the last gen write lives only in an include, so the router's name map never
 * held it: ctx.reverse threw `Unknown route` and failed the build, and
 * router.reverse baked `/__unresolved_reverse/<name>`. A name the seed still
 * holds but the tree no longer declares resolved at build while the live
 * request (seeded from the rewritten gen file) throws; it throws in the bake
 * too, from router.reverse as well as ctx.reverse.
 *
 * Runs the real discoverRouters() in build mode with a fake RSC runner, and
 * real Flight so the bake completes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@vitejs/plugin-rsc/rsc/server", async () => {
  const RSD =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge");
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
  await import("../../../testing/internal/flight-client-globals.js");
  const { createFromReadableStream } =
    await import("@vitejs/plugin-rsc/react/browser");
  return {
    createFromReadableStream: (stream: ReadableStream<Uint8Array>) =>
      createFromReadableStream(stream),
  };
});

import * as serverMod from "../../../server.js";
import * as buildMod from "../../../build/index.js";
import { createRouter } from "../../../router.js";
import { urls } from "../../../urls/urls-function.js";
import { Static } from "../../../static-handler.js";
import { Prerender } from "../../../prerender.js";
import { hasCachedManifest } from "../../../route-map-builder.js";
import { discoverRouters } from "../discover-routers.js";
import { createDiscoveryState } from "../state.js";

const ENTRY = "/app/src/router.tsx";
const STATIC_MODULE = "/app/src/admin.tsx";

const seen: Record<string, string> = {};
function record(key: string, resolve: () => string): void {
  try {
    seen[key] = resolve();
  } catch (error) {
    seen[key] = `threw: ${(error as Error).message}`;
  }
}

let router: any;

const AdminNav = Static((ctx: any) => {
  record("static layout", () => ctx.reverse("nestedMount.admin.settings"));
  const { reverse } = ctx;
  record("static layout detached", () => reverse("nestedMount.admin.settings"));
  record("static layout router.reverse", () =>
    router.reverse("nestedMount.admin.settings"),
  );
  return <nav>admin</nav>;
});

const AdminIndex = Static(async (ctx: any) => {
  await Promise.resolve();
  record("static route .settings after await", () => ctx.reverse(".settings"));
  const borrowed = { link: ctx.reverse };
  record("static route borrowed .report", () => borrowed.link(".report"));
  record("static route removed", () =>
    ctx.reverse("nestedMount.admin.removed"),
  );
  record("static route router.reverse removed", () =>
    router.reverse("nestedMount.admin.removed"),
  );
  return <p>index</p>;
});

const AdminReport = Prerender((ctx: any) => {
  record("prerender route .settings", () => ctx.reverse(".settings"));
  const { reverse } = ctx;
  record("prerender route detached .index", () => reverse(".index"));
  record("prerender route router.reverse", () =>
    router.reverse("nestedMount.admin.report"),
  );
  return <p>report</p>;
});

const admin = urls(({ path, layout }) => [
  layout(AdminNav, () => [
    path("/", AdminIndex, { name: "index" }),
    path("/report", AdminReport, { name: "report" }),
    path("/settings", () => <p>settings</p>, { name: "settings" }),
  ]),
]);
const nested = urls(({ include }) => [
  include("/admin", admin, { name: "admin" }),
]);
const patterns = urls(({ path, include }) => [
  path("/", () => <p>home</p>, { name: "home" }),
  include("/nested-mount", nested, { name: "nestedMount" }),
]);

// The committed gen file as of the last write: it predates `report` and
// `settings`, and still holds `removed`, which the tree no longer declares.
const STALE_SEED = {
  home: "/",
  "nestedMount.admin.index": "/nested-mount/admin",
  "nestedMount.admin.removed": "/nested-mount/admin/removed",
};

function createRscEnv() {
  return {
    runner: {
      async import(id: string): Promise<unknown> {
        if (id === "@rangojs/router/server") return serverMod;
        if (id === "@rangojs/router/build") return buildMod;
        if (id === STATIC_MODULE) return { AdminNav, AdminIndex };
        if (id !== ENTRY) throw new Error(`unexpected import ${id}`);
        router = createRouter({
          id: "bake-gen",
          $$routeNames: STALE_SEED,
        } as any).routes(patterns);
        return {};
      },
    },
  };
}

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "rango-bake-route-map-"));
  serverMod.RouterRegistry.clear();
  for (const key of Object.keys(seen)) delete seen[key];
  for (const method of ["log", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  serverMod.clearCachedManifest();
  vi.restoreAllMocks();
});

describe("build-time bake against the discovered route map", () => {
  it("resolves routes added since the last gen write and drops removed ones", async () => {
    const state = createDiscoveryState(ENTRY, {
      enableBuildPrerender: true,
    } as any);
    state.projectRoot = projectRoot;
    state.isBuildMode = true;
    state.resolvedStaticModules = new Map([
      [STATIC_MODULE, ["AdminNav", "AdminIndex"]],
    ]);

    // build-discovery-phase.ts raises this flag around discoverRouters().
    (globalThis as any).__rscRouterDiscoveryActive = true;
    try {
      await discoverRouters(state, createRscEnv(), undefined);
    } finally {
      delete (globalThis as any).__rscRouterDiscoveryActive;
    }

    expect(seen).toEqual({
      "static layout": "/nested-mount/admin/settings",
      "static layout detached": "/nested-mount/admin/settings",
      "static layout router.reverse": "/nested-mount/admin/settings",
      "static route .settings after await": "/nested-mount/admin/settings",
      "static route borrowed .report": "/nested-mount/admin/report",
      "static route removed": expect.stringMatching(
        /^threw: Unknown route: "nestedMount\.admin\.removed"/,
      ),
      "static route router.reverse removed":
        "threw: Unknown route: nestedMount.admin.removed",
      "prerender route .settings": "/nested-mount/admin/settings",
      "prerender route detached .index": "/nested-mount/admin",
      "prerender route router.reverse": "/nested-mount/admin/report",
    });
    expect(Object.keys(state.staticManifestEntries ?? {})).toHaveLength(2);
    // The build's PPR shell capture runs later in this realm and gives
    // middleware a reverse over the global map (build-shell-capture.ts).
    const globalMap = serverMod.getGlobalRouteMap();
    expect(globalMap["nestedMount.admin.settings"]).toBe(
      "/nested-mount/admin/settings",
    );
    expect(globalMap["nestedMount.admin.removed"]).toBeUndefined();
    expect(router.reverse("nestedMount.admin.settings")).toBe(
      "/nested-mount/admin/settings",
    );
  });

  it("leaves a dev discovery's router and global map to propagateDiscoveryState", async () => {
    const state = createDiscoveryState(ENTRY, undefined);
    state.projectRoot = projectRoot;

    await discoverRouters(state, createRscEnv(), undefined);

    expect(state.mergedRouteManifest?.["nestedMount.admin.settings"]).toBe(
      "/nested-mount/admin/settings",
    );
    expect(seen).toEqual({});
    expect(hasCachedManifest()).toBe(false);
    expect(router.reverse("nestedMount.admin.removed")).toBe(
      "/nested-mount/admin/removed",
    );
  });
});
