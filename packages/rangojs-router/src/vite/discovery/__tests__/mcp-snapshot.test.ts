import { describe, expect, it } from "vitest";
import {
  createMcpRouteSnapshot,
  createMcpRouterSnapshot,
} from "../mcp-snapshot.js";
import { createDiscoveryState } from "../state.js";

describe("MCP route snapshot", () => {
  it("projects public-safe runtime route metadata", () => {
    const state = createDiscoveryState("/workspace/app/src/router.tsx", {
      preset: "node",
    });
    state.projectRoot = "/workspace/app";
    state.perRouterManifests = [
      {
        id: "app",
        sourceFile: "/workspace/app/src/router.tsx",
        routeManifest: {
          home: "/",
          "shop.product": "/shop/:id",
          $path__health: "/health",
          wildcard: "/files/*path",
        },
        routeTrailingSlash: { home: "always" },
        routeSearchSchemas: {
          "shop.product": { tab: "string" },
        },
      },
    ];

    expect(createMcpRouteSnapshot(state)).toEqual([
      {
        routerId: "app",
        routerFile: "src/router.tsx",
        name: "home",
        pattern: "/",
        kind: "static",
        trailingSlash: "always",
        search: null,
        truncated: false,
      },
      {
        routerId: "app",
        routerFile: "src/router.tsx",
        name: "shop.product",
        pattern: "/shop/:id",
        kind: "parameterized",
        trailingSlash: null,
        search: { tab: "string" },
        truncated: false,
      },
      {
        routerId: "app",
        routerFile: "src/router.tsx",
        name: null,
        pattern: "/health",
        kind: "static",
        trailingSlash: null,
        search: null,
        truncated: false,
      },
      {
        routerId: "app",
        routerFile: "src/router.tsx",
        name: "wildcard",
        pattern: "/files/*path",
        kind: "wildcard",
        trailingSlash: null,
        search: null,
        truncated: false,
      },
    ]);
    expect(createMcpRouterSnapshot(state)).toEqual([
      { id: "app", file: "src/router.tsx" },
    ]);
  });

  it("bounds user-controlled route metadata and reports truncation", () => {
    const state = createDiscoveryState("/workspace/app/src/router.tsx", {
      preset: "node",
    });
    state.projectRoot = "/workspace/app";
    state.perRouterManifests = [
      {
        id: "r".repeat(2_000),
        sourceFile: `/workspace/app/${"f".repeat(2_000)}.tsx`,
        routeManifest: { ["n".repeat(5_000)]: `/${"p".repeat(5_000)}` },
        routeSearchSchemas: {
          ["n".repeat(5_000)]: Object.fromEntries(
            Array.from({ length: 70 }, (_, index) => [
              `key-${index}-${"k".repeat(300)}`,
              "v".repeat(300),
            ]),
          ),
        },
      },
    ];

    const [route] = createMcpRouteSnapshot(state);
    expect(route).toMatchObject({ truncated: true });
    expect(route!.routerId.length).toBe(1_024);
    expect(route!.routerFile!.length).toBe(1_024);
    expect(route!.name!.length).toBe(4_096);
    expect(route!.pattern.length).toBe(4_096);
    expect(Object.keys(route!.search!)).toHaveLength(64);

    state.perRouterManifests[0]!.routeManifest = {
      multibyte: `/${"\u{1f680}".repeat(5_000)}`,
    };
    const [multibyteRoute] = createMcpRouteSnapshot(state);
    expect(
      Buffer.byteLength(multibyteRoute!.pattern, "utf8"),
    ).toBeLessThanOrEqual(4_096);
    expect(multibyteRoute!.truncated).toBe(true);
  });
});
