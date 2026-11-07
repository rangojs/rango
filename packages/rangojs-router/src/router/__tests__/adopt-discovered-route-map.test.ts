import { afterEach, describe, expect, it, vi } from "vitest";

// createRouter's match path imports @vitejs/plugin-rsc/rsc, whose top-level
// body imports Vite virtual modules that do not resolve in plain vitest.
function pluginRscMock() {
  return {
    createFromReadableStream: vi.fn(),
    renderToReadableStream: vi.fn(),
    loadServerAction: vi.fn(),
    decodeReply: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createTemporaryReferenceSet: vi.fn(),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { createRouter } from "../../router.js";
import type { RangoInternal } from "../router-interfaces.js";
import { urls } from "../../urls/urls-function.js";
import { generateManifestFull } from "../../build/generate-manifest.js";

const settings = urls(({ path }) => [
  path("/settings", () => null, { name: "settings" }),
]);
const patterns = urls(({ path, include }) => [
  path("/", () => null, { name: "home" }),
  include("/admin", settings, { name: "admin" }),
]);

function attempt(resolve: () => string): string {
  try {
    return resolve();
  } catch (error) {
    return `threw: ${(error as Error).message}`;
  }
}

afterEach(() => {
  delete (globalThis as any).__rscRouterDiscoveryActive;
});

// Build-time discovery (discover-routers.ts) hands each router the route map
// it generated before the Static/Prerender bake; the bake-level behaviour is
// pinned by src/vite/discovery/__tests__/bake-discovered-route-map.rsc-test.tsx.
describe("adoptDiscoveredRouteMap", () => {
  it("adds include children, keeps a basename, and drops names only the seed held", async () => {
    const router = createRouter({
      id: "adopt-basename",
      basename: "/app",
      $$routeNames: { home: "/app", "admin.gone": "/app/admin/gone" },
    } as any).routes(patterns) as unknown as RangoInternal<any, any>;
    const reverse = router.reverse as (name: string) => string;
    expect(attempt(() => reverse("admin.settings"))).toBe(
      "threw: Unknown route: admin.settings",
    );

    const { routeManifest } = await generateManifestFull(patterns, 0, {
      routerId: "adopt-basename",
      urlPrefix: "/app",
    });
    router.adoptDiscoveredRouteMap(routeManifest);

    expect(reverse("home")).toBe("/app");
    expect(reverse("admin.settings")).toBe("/app/admin/settings");
    expect(attempt(() => reverse("admin.gone"))).toBe(
      "threw: Unknown route: admin.gone",
    );
  });

  it("keeps names routes() registered and leaves other routers' maps alone", () => {
    const other = createRouter({ id: "adopt-other" }).routes(
      urls(({ path }) => [path("/b", () => null, { name: "bOnly" })]),
    ) as unknown as RangoInternal<any, any>;
    const router = createRouter({ id: "adopt-own" }).routes(
      patterns,
    ) as unknown as RangoInternal<any, any>;

    // A pattern routes() registered wins over the discovered one, as it does
    // over the gen-file seed at module load in production.
    router.adoptDiscoveredRouteMap({
      home: "/discovered-home",
      "admin.settings": "/admin/settings",
    });
    other.adoptDiscoveredRouteMap({});

    const reverse = router.reverse as (name: string) => string;
    const otherReverse = other.reverse as (name: string) => string;
    expect(reverse("home")).toBe("/");
    expect(otherReverse("bOnly")).toBe("/b");
    expect(attempt(() => otherReverse("admin.settings"))).toBe(
      "threw: Unknown route: admin.settings",
    );
  });

  it("throws for an unknown name during discovery once the map is complete", () => {
    (globalThis as any).__rscRouterDiscoveryActive = true;
    const router = createRouter({ id: "adopt-complete" }).routes(
      patterns,
    ) as unknown as RangoInternal<any, any>;
    const reverse = router.reverse as (name: string) => string;
    // Before discovery fills the map, an include child is a placeholder.
    expect(reverse("admin.settings")).toBe(
      "/__unresolved_reverse/admin.settings",
    );

    router.adoptDiscoveredRouteMap({
      home: "/",
      "admin.settings": "/admin/settings",
    });

    expect(reverse("admin.settings")).toBe("/admin/settings");
    expect(attempt(() => reverse("admin.typo"))).toBe(
      "threw: Unknown route: admin.typo",
    );
  });
});
