import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCombinedRouteDetailsForRouterFile } from "../../../build/route-types/router-processing.js";
import {
  createMcpRouteMatchIndexes,
  createMcpRouteSnapshot,
  createMcpRouterSnapshot,
  createMcpSourceOwnershipSnapshot,
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

  it("keeps truncated router identities collision-safe across snapshots", () => {
    const state = createDiscoveryState("/workspace/app/src/router.tsx", {
      preset: "node",
    });
    state.projectRoot = "/workspace/app";
    const sharedPrefix = "r".repeat(1_100);
    state.perRouterManifests = [
      {
        id: `${sharedPrefix}-alpha`,
        sourceFile: "/workspace/app/src/alpha.tsx",
        routeManifest: { home: "/alpha" },
      },
      {
        id: `${sharedPrefix}-beta`,
        sourceFile: "/workspace/app/src/beta.tsx",
        routeManifest: { home: "/beta" },
      },
    ];

    const routeIds = createMcpRouteSnapshot(state).map(
      (route) => route.routerId,
    );
    const routerIds = createMcpRouterSnapshot(state).map((router) => router.id);
    const matchIds = createMcpRouteMatchIndexes(state).map(
      (index) => index.routerId,
    );
    const ownershipIds = createMcpSourceOwnershipSnapshot(state).map(
      (record) => record.routerId,
    );

    for (const ids of [routeIds, routerIds, matchIds, ownershipIds]) {
      expect(new Set(ids)).toHaveLength(2);
      expect(ids.every((id) => Buffer.byteLength(id, "utf8") <= 1_024)).toBe(
        true,
      );
      expect(ids.every((id) => id.includes("...#"))).toBe(true);
    }
  });

  it("maps named routes to declaration files without evaluating route code", () => {
    const root = mkdtempSync(join(tmpdir(), "rango-mcp-source-"));
    const src = join(root, "src");
    mkdirSync(src);
    const routerFile = join(src, "router.tsx");
    writeFileSync(
      routerFile,
      `import { createRouter } from "@rangojs/router";
import { patterns } from "./urls.js";
export const router = createRouter({ urls: patterns });
`,
    );
    writeFileSync(
      join(src, "urls.tsx"),
      `import { urls } from "@rangojs/router";
export const patterns = urls(({ path }) => [
  path("/blog/:postId", null, { name: "blog.post" }),
]);
`,
    );
    try {
      const state = createDiscoveryState(routerFile, { preset: "node" });
      state.projectRoot = root;
      state.perRouterManifests = [
        {
          id: "app",
          sourceFile: routerFile,
          routeSourceFiles:
            buildCombinedRouteDetailsForRouterFile(routerFile).sourceFiles,
          routeManifest: {
            "blog.post": "/blog/:postId",
            factoryOnly: "/factory",
          },
        },
      ];

      expect(createMcpSourceOwnershipSnapshot(state)).toEqual([
        {
          routerId: "app",
          routeName: "blog.post",
          routePattern: "/blog/:postId",
          source: {
            file: "src/urls.tsx",
            kind: "route",
            precision: "declaration-file",
          },
        },
        {
          routerId: "app",
          routeName: "factoryOnly",
          routePattern: "/factory",
          source: {
            file: "src/router.tsx",
            kind: "route",
            precision: "router-file",
          },
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
