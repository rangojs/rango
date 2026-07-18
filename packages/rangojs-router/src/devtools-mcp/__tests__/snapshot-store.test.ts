import { describe, expect, it, vi } from "vitest";
import {
  RANGO_MCP_MAX_RESULT_BYTES,
  type RouteRecord,
  type RouterRecord,
} from "../protocol.js";
import { jsonToolResult } from "../server.js";
import { buildRouteTrie } from "../../build/route-trie.js";
import {
  createRangoMcpSnapshotStore,
  type RouteMatchIndex,
} from "../snapshot-store.js";

function route(name: string, pattern: string, routerId = "app"): RouteRecord {
  return {
    routerId,
    routerFile: "src/router.tsx",
    name,
    pattern,
    kind: pattern.includes(":") ? "parameterized" : "static",
    trailingSlash: null,
    search: null,
    truncated: false,
  };
}

function createStore(
  instanceId = "00000000-0000-4000-8000-000000000001",
  preset: "node" | "cloudflare" = "node",
) {
  return createRangoMcpSnapshotStore({
    projectRoot: "/workspace/app",
    preset,
    mode: "development",
    entryFile: "src/router.tsx",
    rangoVersion: "1.2.3",
    instanceId,
    startedAt: "2026-07-14T00:00:00.000Z",
    getDevServerUrls: () => ["http://localhost:5173/"],
  });
}

function routers(...ids: string[]): RouterRecord[] {
  return ids.map((id) => ({ id, file: "src/router.tsx" }));
}

function matchIndex(): RouteMatchIndex {
  return {
    routerId: "app",
    trie: buildRouteTrie(
      { product: "/products/:id", wildcard: "/products/*rest" },
      { product: "", wildcard: "" },
    ),
    routes: {
      product: {
        name: "product",
        pattern: "/products/:id",
        search: { tab: "string" },
        structure: null,
        truncated: false,
      },
      wildcard: {
        name: "wildcard",
        pattern: "/products/*rest",
        search: null,
        structure: null,
        truncated: false,
      },
    },
  };
}

describe("Rango MCP snapshot store", () => {
  it("reports stale until the first successful discovery is ready", () => {
    const store = createStore();
    expect(store.getDiscoveryStatus()).toMatchObject({
      phase: "starting",
      generation: 0,
      stale: true,
    });
    const attempt = store.beginDiscovery();
    expect(store.getDiscoveryStatus()).toMatchObject({
      phase: "discovering",
      generation: 0,
      stale: true,
    });
    store.failDiscovery(new Error("first discovery failed"), attempt);
    expect(store.getDiscoveryStatus()).toMatchObject({
      phase: "error",
      generation: 0,
      stale: true,
    });
    const recovery = store.beginDiscovery();
    store.publishRoutes([route("home", "/")], routers("app"), recovery);
    expect(store.getDiscoveryStatus()).toMatchObject({
      phase: "ready",
      generation: 1,
      stale: false,
    });
  });

  it("preserves the last successful routes when discovery fails", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T10:00:00.000Z"));
    const store = createStore();

    const firstAttempt = store.beginDiscovery();
    store.publishRoutes([route("home", "/")], routers("app"), firstAttempt, [
      {
        routerId: "app",
        routeName: "home",
        routePattern: "/",
        source: {
          file: "src/urls.tsx",
          kind: "route",
          precision: "declaration-file",
        },
      },
    ]);
    vi.setSystemTime(new Date("2026-07-14T10:01:00.000Z"));
    const secondAttempt = store.beginDiscovery();
    store.failDiscovery(new Error("broken include"), secondAttempt);

    expect(store.getDiscoveryStatus()).toMatchObject({
      phase: "error",
      attempt: 2,
      generation: 1,
      stale: true,
      routerCount: 1,
      routeCount: 1,
      lastError: { message: "broken include" },
    });
    expect(store.getRoutes().routes).toEqual([
      expect.objectContaining({ name: "home", pattern: "/" }),
    ]);
    expect(store.getRouteSource("app", "home", "/")).toEqual({
      file: "src/urls.tsx",
      kind: "route",
      precision: "declaration-file",
    });
    vi.useRealTimers();
  });

  it("paginates one immutable discovery generation", () => {
    const store = createStore();
    const firstAttempt = store.beginDiscovery();
    store.publishRoutes(
      [
        route("third", "/third"),
        route("first", "/first"),
        route("second", "/second"),
      ],
      routers("app"),
      firstAttempt,
    );

    const first = store.getRoutes({ limit: 2 });
    expect(first.routes.map((item) => item.name)).toEqual(["first", "second"]);
    expect(first.nextCursor).not.toBeNull();
    expect(
      store.getRoutes({ limit: 2, cursor: first.nextCursor! }).routes,
    ).toEqual([expect.objectContaining({ name: "third" })]);

    const secondAttempt = store.beginDiscovery();
    store.publishRoutes(
      [route("next", "/next")],
      routers("app"),
      secondAttempt,
    );
    expect(() =>
      store.getRoutes({ limit: 2, cursor: first.nextCursor! }),
    ).toThrow("Routes changed after this cursor was issued");
  });

  it("filters by router and reports project metadata capabilities", () => {
    const store = createStore();
    const attempt = store.beginDiscovery();
    store.publishRoutes(
      [route("home", "/", "site"), route("health", "/health", "api")],
      routers("site", "api", "empty"),
      attempt,
    );

    expect(store.getRoutes({ routerId: "api" })).toMatchObject({
      routerCount: 3,
      totalRoutes: 1,
      routes: [expect.objectContaining({ routerId: "api", name: "health" })],
    });
    expect(store.getProjectMetadata()).toMatchObject({
      toolSchemaVersion: 5,
      entryFile: "src/router.tsx",
      routers: [
        { id: "api", file: "src/router.tsx" },
        { id: "empty", file: "src/router.tsx" },
        { id: "site", file: "src/router.tsx" },
      ],
      routersTruncated: false,
      capabilities: {
        routes: true,
        routeMatching: true,
        discoveryStatus: true,
        compilationIssues: true,
        recentRequests: true,
        runtimeErrors: true,
        renderExplanation: true,
        revalidationExplanation: true,
        cacheTagExplanation: true,
        sourceOwnership: true,
      },
    });
  });

  it("matches the canonical trie without creating request state", () => {
    const store = createStore();
    const attempt = store.beginDiscovery();
    store.publishRoutes(
      [route("product", "/products/:id"), route("wildcard", "/products/*rest")],
      routers("app"),
      attempt,
      [
        {
          routerId: "app",
          routeName: "product",
          routePattern: "/products/:id",
          source: {
            file: "src/products.tsx",
            kind: "route",
            precision: "declaration-file",
          },
        },
      ],
      [matchIndex()],
    );

    expect(
      store.matchRoute({ url: "/products/42?secret=value" }),
    ).toMatchObject({
      pathname: "/products/42",
      routerId: "app",
      matched: true,
      route: {
        name: "product",
        pattern: "/products/:id",
        params: { id: "42" },
        search: { tab: "string" },
        source: { file: "src/products.tsx" },
      },
    });
    expect(
      JSON.stringify(store.matchRoute({ url: "/products/42?secret=value" })),
    ).not.toContain("secret");
    expect(store.matchRoute({ url: "/missing" })).toMatchObject({
      matched: false,
      route: null,
    });
  });

  it("rejects a cursor issued by a previous server instance", () => {
    const firstStore = createStore();
    const firstAttempt = firstStore.beginDiscovery();
    firstStore.publishRoutes(
      [route("first", "/first"), route("second", "/second")],
      routers("app"),
      firstAttempt,
    );
    const cursor = firstStore.getRoutes({ limit: 1 }).nextCursor!;

    const nextStore = createStore("00000000-0000-4000-8000-000000000002");
    const nextAttempt = nextStore.beginDiscovery();
    nextStore.publishRoutes(
      [route("first", "/first"), route("second", "/second")],
      routers("app"),
      nextAttempt,
    );

    expect(() => nextStore.getRoutes({ cursor })).toThrow(
      "previous development server",
    );
  });

  it("does not let an older or superseded attempt report ready", () => {
    const store = createStore();
    const olderAttempt = store.beginDiscovery();
    const newerAttempt = store.beginDiscovery();
    store.publishRoutes([route("old", "/old")], routers("app"), olderAttempt);
    expect(store.getDiscoveryStatus()).toMatchObject({
      phase: "discovering",
      generation: 0,
    });

    store.markDiscoveryPending();
    store.publishRoutes([route("new", "/new")], routers("app"), newerAttempt);
    expect(store.getDiscoveryStatus()).toMatchObject({
      phase: "discovering",
      generation: 1,
      stale: true,
    });
  });

  it("redacts and bounds discovery errors without invoking arbitrary coercion", () => {
    const store = createStore();
    const attempt = store.beginDiscovery();
    store.failDiscovery(
      {
        message:
          "/workspace/app/src/router.tsx?token=visible password=visible authorization=Bearer leaked " +
          "postgres://user:pass@localhost/db access_token=leaked2 Bearer leaked3 " +
          "stripe_secret=leaked4 AWS_SECRET_ACCESS_KEY=leaked5 PRIVATE_KEY=leaked6 " +
          'cookie: sid=leaked7; theme=dark\n{"stripe_secret":"leaked8","AWS_SECRET_ACCESS_KEY":"leaked9","PRIVATE_KEY":"abc\\"leaked10"}\n\u0000' +
          "x".repeat(3_000),
        toString: () => {
          throw new Error("must not run");
        },
      },
      attempt,
    );

    const message = store.getDiscoveryStatus().lastError!.message;
    expect(message).not.toContain("visible");
    expect(message).not.toContain("leaked");
    expect(message).not.toContain("user:pass");
    expect(message).not.toContain("theme=dark");
    expect(message).not.toContain("/workspace/app");
    expect(message).toHaveLength(2_048);
  });

  it("bounds route pages by encoded size and provides a continuation cursor", () => {
    const store = createStore();
    const attempt = store.beginDiscovery();
    store.publishRoutes(
      Array.from({ length: 20 }, (_, index) =>
        route(`route-${index}`, `/${"x".repeat(16_000)}-${index}`),
      ),
      routers("app"),
      attempt,
    );

    const page = store.getRoutes({ limit: 20 });
    expect(page.routes.length).toBeGreaterThan(0);
    expect(page.routes.length).toBeLessThan(20);
    expect(page.nextCursor).not.toBeNull();
    expect(page.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(jsonToolResult(page)), "utf8"),
    ).toBeLessThanOrEqual(RANGO_MCP_MAX_RESULT_BYTES);
  });

  it("bounds full results for many small and one multibyte route", () => {
    const store = createStore();
    const attempt = store.beginDiscovery();
    store.publishRoutes(
      [
        ...Array.from({ length: 1_000 }, (_, index) =>
          route(`route-${index}`, `/route-${index}`),
        ),
        route("multibyte", `/${"\u{1f680}".repeat(100_000)}`),
      ],
      routers("app"),
      attempt,
    );

    let cursor: string | undefined;
    let sawTruncatedRoute = false;
    do {
      const page = store.getRoutes({ limit: 1_000, cursor });
      expect(
        Buffer.byteLength(JSON.stringify(jsonToolResult(page)), "utf8"),
      ).toBeLessThanOrEqual(RANGO_MCP_MAX_RESULT_BYTES);
      sawTruncatedRoute ||= page.routes.some((item) => item.truncated);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(sawTruncatedRoute).toBe(true);
  });

  it("preserves a collision-safe router ID when truncating one route", () => {
    const store = createStore();
    const attempt = store.beginDiscovery();
    const routerId = `${"r".repeat(490)}...#0123456789ab`;
    store.publishRoutes(
      [route("oversized", `/${"x".repeat(300_000)}`, routerId)],
      routers(routerId),
      attempt,
    );

    const [result] = store.getRoutes().routes;
    expect(result).toMatchObject({ routerId, truncated: true });
  });

  it("reports Cloudflare runtime convergence independently from discovery", () => {
    const store = createStore(
      "00000000-0000-4000-8000-000000000001",
      "cloudflare",
    );
    const attempt = store.beginDiscovery();
    store.publishRoutes([route("home", "/")], routers("app"), attempt);
    store.markRuntimeConvergence("pending");
    expect(store.getDiscoveryStatus()).toMatchObject({
      phase: "ready",
      stale: true,
      runtimeConvergence: "pending",
    });

    store.markRuntimeConvergence("ready");
    expect(store.getDiscoveryStatus()).toMatchObject({
      stale: false,
      runtimeConvergence: "ready",
    });
  });

  it("distinguishes source ownership for route variants sharing a pattern", () => {
    const store = createStore();
    const attempt = store.beginDiscovery();
    store.publishRoutes(
      [
        route("productPage", "/products/:id"),
        route("productJson", "/products/:id"),
      ],
      routers("app"),
      attempt,
      [
        {
          routerId: "app",
          routeName: "productPage",
          routePattern: "/products/:id",
          source: {
            file: "src/pages.tsx",
            kind: "route",
            precision: "declaration-file",
          },
        },
        {
          routerId: "app",
          routeName: "productJson",
          routePattern: "/products/:id",
          source: {
            file: "src/api.ts",
            kind: "route",
            precision: "declaration-file",
          },
        },
      ],
    );

    expect(
      store.getRouteSource("app", "productPage", "/products/:id"),
    ).toMatchObject({ file: "src/pages.tsx" });
    expect(
      store.getRouteSource("app", "productJson", "/products/:id"),
    ).toMatchObject({ file: "src/api.ts" });
    expect(store.getRouteSource("app", null, "/products/:id")).toBeNull();
  });

  it("bounds router metadata while preserving the total router count", () => {
    const store = createStore();
    const attempt = store.beginDiscovery();
    store.publishRoutes(
      [],
      Array.from({ length: 40 }, (_, index) => ({
        id: `router-${index.toString().padStart(2, "0")}`,
        file: `src/router-${index}.tsx`,
      })),
      attempt,
    );

    expect(store.getDiscoveryStatus().routerCount).toBe(40);
    const metadata = store.getProjectMetadata();
    expect(metadata.routers).toHaveLength(32);
    expect(metadata.routersTruncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(jsonToolResult(metadata)), "utf8"),
    ).toBeLessThanOrEqual(RANGO_MCP_MAX_RESULT_BYTES);
  });
});
