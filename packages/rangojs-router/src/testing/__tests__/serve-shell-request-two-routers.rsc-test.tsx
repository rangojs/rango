/**
 * Two routers, one cache store, one host and path (issue #1065), through the
 * public testing primitives. A host router normally sends one host to one
 * router, but a `hostOverride` cookie picks the router and forwards the
 * request unmodified, and a `router.prerender()` warm requests whatever
 * origin it resolved, so two routers can serve the same host and path. Each
 * must read and write its own shell.
 *
 * Both routers name the route `shelled` at `/shelled`: nothing but the router
 * tells the two pages apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { setBuildVersions } from "../index.js";
import { createRouter, urls } from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  type SegmentCacheStore,
} from "../../cache/index.js";
import { createHostRouter } from "../../host/index.js";

/**
 * One store both routers use, visible to every location, as the KV-backed
 * store of a deployed multi-router worker is.
 */
class SharedMemoryStore extends MemorySegmentCacheStore {
  readonly scope = "global" as const;
}

type App = "a" | "b";

/** Handler runs per router: a served shell that is not the router's own runs none. */
const runs: Record<App, number> = { a: 0, b: 0 };

function makeRouter(app: App, store: SegmentCacheStore, version?: string) {
  return createRouter({
    id: `app-${app}`,
    cache: { store },
    ...(version !== undefined && { version }),
  }).routes(
    urls(({ path }) => [
      path(
        "/shelled",
        () => {
          runs[app] += 1;
          return <h1>{`app-${app}-page`}</h1>;
        },
        { name: "shelled", ppr: true },
      ),
    ]),
  );
}

type TestRouter = ReturnType<typeof makeRouter>;

function makeRouters(
  store: SegmentCacheStore,
  version?: string,
): Record<App, TestRouter> {
  return {
    a: makeRouter("a", store, version),
    b: makeRouter("b", store, version),
  };
}

/** The pages a response text names: one router's, never the other's. */
function pagesIn(text: string | undefined): string[] {
  return [...new Set(text?.match(/app-[ab]-page/g) ?? [])];
}

/** A document the router rendered itself: a MISS with its own page. */
function expectOwnMiss(result: ServeShellRequestResult, app: App): void {
  expect({
    shell: result.shellStatus,
    pages: pagesIn(result.body),
  }).toEqual({ shell: "MISS", pages: [`app-${app}-page`] });
}

/** A HIT whose prelude and tail are the router's own page. */
function expectOwnHit(result: ServeShellRequestResult, app: App): void {
  expect({
    shell: result.shellStatus,
    prelude: pagesIn(result.prelude),
    pages: pagesIn(result.body),
  }).toEqual({
    shell: "HIT",
    prelude: [`app-${app}-page`],
    pages: [`app-${app}-page`],
  });
}

/** Each router has its own cache versions, as a production build gives them. */
function setPerRouterVersions(): void {
  setBuildVersions({
    data: "d-build",
    document: "h-build",
    routers: {
      "app-a": { data: "d-a", document: "h-a" },
      "app-b": { data: "d-b", document: "h-b" },
    },
  });
}

beforeEach(async () => {
  await resetShellTestState();
  setBuildVersions();
  runs.a = 0;
  runs.b = 0;
});

afterEach(() => {
  setBuildVersions();
  vi.restoreAllMocks();
});

describe("two routers on one host and path, one cache store", () => {
  const SHARED_URL = "http://shared.example/shelled";

  it.each([
    {
      versions: "one build version (the whole-build pair)",
      arrange: (): string | undefined => {
        setBuildVersions({ data: "d1", document: "h1" });
        return undefined;
      },
    },
    {
      versions: "the same createRouter({ version }) on both",
      arrange: (): string | undefined => "release-1",
    },
  ])(
    "$versions: a router never serves the other's shell",
    async ({ arrange }) => {
      const { a, b } = makeRouters(new SharedMemoryStore(), arrange());

      expectOwnMiss(await serveShellRequest(a, SHARED_URL), "a");

      expectOwnMiss(await serveShellRequest(b, SHARED_URL), "b");
      expect(runs.b).toBeGreaterThan(0);

      expectOwnHit(await serveShellRequest(a, SHARED_URL), "a");
      expectOwnHit(await serveShellRequest(b, SHARED_URL), "b");
    },
  );

  it("per-router versions: neither router's capture evicts the other's shell", async () => {
    setPerRouterVersions();
    const { a, b } = makeRouters(new SharedMemoryStore());

    expectOwnMiss(await serveShellRequest(a, SHARED_URL), "a");
    expectOwnMiss(await serveShellRequest(b, SHARED_URL), "b");

    // Each router's second request reads the shell its own first one captured.
    expectOwnHit(await serveShellRequest(a, SHARED_URL), "a");
    expectOwnHit(await serveShellRequest(b, SHARED_URL), "b");
    expectOwnHit(await serveShellRequest(a, SHARED_URL), "a");
  });

  it("each router keeps its own shell entry in the shared store", async () => {
    const { a, b } = makeRouters(new SharedMemoryStore());

    const fromA = await serveShellRequest(a, SHARED_URL);
    const fromB = await serveShellRequest(b, SHARED_URL);

    expect(fromA.key).not.toBe(fromB.key);
    expect((await fromA.readEntry())?.prelude).toBeDefined();
    expect((await fromB.readEntry())?.prelude).toBeDefined();
  });

  it("a navigation replays the shell of the router it is sent to", async () => {
    const { a, b } = makeRouters(new SharedMemoryStore());
    await serveShellRequest(a, SHARED_URL);

    // Router B has captured nothing: its navigation finds no entry to replay.
    const cold = await serveShellRequest(b, SHARED_URL, { partial: true });
    expect({
      replay: cold.replayStatus,
      pages: pagesIn(cold.body),
    }).toEqual({
      replay: { outcome: "BYPASS", reason: "no-entry" },
      pages: ["app-b-page"],
    });

    const own = await serveShellRequest(a, SHARED_URL, { partial: true });
    expect({
      replay: own.replayStatus?.outcome,
      pages: pagesIn(own.body),
    }).toEqual({ replay: "HIT", pages: ["app-a-page"] });
  });
});

describe("createHostRouter({ hostOverride }): a cookie picks the router for one URL host", () => {
  const PREVIEW_URL = "http://preview.dev/shelled";

  /**
   * The host router of a preview deployment: `preview.dev` is the one public
   * host, and the `app` cookie names the app to serve there. The matched
   * handler gets the request unmodified, so both routers see `preview.dev`.
   */
  function makePreview(routers: Record<App, TestRouter>): {
    request: (app: App) => Promise<ServeShellRequestResult>;
  } {
    const served: ServeShellRequestResult[] = [];
    const serve =
      (router: TestRouter) =>
      async (request: Request): Promise<Response> => {
        const result = await serveShellRequest(router, request.url, {
          headers: request.headers,
        });
        served.push(result);
        return new Response(result.body, result.response);
      };
    const host = createHostRouter({
      hostOverride: { cookieName: "app", allowedHosts: ["preview.dev"] },
    });
    host.host("a.internal").map(serve(routers.a));
    host.host("b.internal").map(serve(routers.b));
    return {
      request: async (app) => {
        await host.match(
          new Request(PREVIEW_URL, {
            headers: { accept: "text/html", cookie: `app=${app}.internal` },
          }),
        );
        return served.pop()!;
      },
    };
  }

  it("one version: the second app's request is not a HIT with the first app's shell", async () => {
    setBuildVersions({ data: "d1", document: "h1" });
    const preview = makePreview(makeRouters(new SharedMemoryStore()));

    expectOwnMiss(await preview.request("a"), "a");
    expectOwnMiss(await preview.request("b"), "b");

    expectOwnHit(await preview.request("a"), "a");
    expectOwnHit(await preview.request("b"), "b");
  });

  it("per-router versions: switching the cookie back and forth keeps both shells", async () => {
    setPerRouterVersions();
    const preview = makePreview(makeRouters(new SharedMemoryStore()));

    expectOwnMiss(await preview.request("a"), "a");
    expectOwnMiss(await preview.request("b"), "b");
    expectOwnHit(await preview.request("a"), "a");
    expectOwnHit(await preview.request("b"), "b");
  });
});

describe("router.prerender() warm under another router's host", () => {
  const B_HOST_URL = "http://b.example/shelled";

  it("a shell one router warmed on a host is not served by the router that owns the host", async () => {
    setBuildVersions({ data: "d1", document: "h1" });
    const { a, b } = makeRouters(new SharedMemoryStore());

    // Router B's host, resolved as router A's warm origin: what a route of B
    // calling A's runner with no `origin` does.
    const warmed = await a.prerender({ env: {} })(B_HOST_URL);
    expect(warmed).toMatchObject({ ok: true, status: "warmed" });
    expect(runs.b).toBe(0);

    expectOwnMiss(await serveShellRequest(b, B_HOST_URL), "b");
    expect(runs.b).toBeGreaterThan(0);

    expectOwnHit(await serveShellRequest(b, B_HOST_URL), "b");
    // The warm was not wasted: router A serves it where A is asked for it.
    expectOwnHit(await serveShellRequest(a, B_HOST_URL), "a");
  });
});
