/**
 * Two routers, one cache store, one host and path (issue #1065), through the
 * public testing primitives. A host router normally sends one host to one
 * router, but a `hostOverride` cookie picks the router and forwards the
 * request unmodified, and a `router.prerender()` warm requests whatever
 * origin it resolved, so two routers can serve the same host and path. Each
 * must read and write its own shell.
 *
 * Both routers name the route `shelled` at `/shelled`: nothing but the router
 * tells the two pages apart (helpers/two-router-fixture.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { createHostRouter } from "../../host/index.js";
import {
  makeRouters,
  memoryStore,
  ownHit,
  ownMiss,
  resetRuns,
  runs,
  shellServed,
  type App,
  type TestRouter,
} from "./helpers/two-router-fixture.js";

const sharedStore = () => memoryStore().cacheStore;

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
  resetRuns();
});

afterEach(() => {
  setBuildVersions();
  vi.restoreAllMocks();
});

describe("two routers on one host and path, one cache store", () => {
  const SHARED_URL = "http://shared.example/shelled";
  const served = async (router: TestRouter) =>
    shellServed(await serveShellRequest(router, SHARED_URL));

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
      const { a, b } = makeRouters(sharedStore(), { version: arrange() });

      expect(await served(a)).toEqual(ownMiss("a"));

      expect(await served(b)).toEqual(ownMiss("b"));
      expect(runs.b).toBeGreaterThan(0);

      expect(await served(a)).toEqual(ownHit("a"));
      expect(await served(b)).toEqual(ownHit("b"));
    },
  );

  it("per-router versions: neither router's capture evicts the other's shell", async () => {
    setPerRouterVersions();
    const { a, b } = makeRouters(sharedStore());

    expect(await served(a)).toEqual(ownMiss("a"));
    expect(await served(b)).toEqual(ownMiss("b"));

    // Each router's second request reads the shell its own first one captured.
    expect(await served(a)).toEqual(ownHit("a"));
    expect(await served(b)).toEqual(ownHit("b"));
    expect(await served(a)).toEqual(ownHit("a"));
  });

  it("each router keeps its own shell entry in the shared store", async () => {
    const { a, b } = makeRouters(sharedStore());

    const fromA = await serveShellRequest(a, SHARED_URL);
    const fromB = await serveShellRequest(b, SHARED_URL);

    expect(fromA.key).not.toBe(fromB.key);
    expect((await fromA.readEntry())?.prelude).toBeDefined();
    expect((await fromB.readEntry())?.prelude).toBeDefined();
  });

  it("a navigation replays the shell of the router it is sent to", async () => {
    const { a, b } = makeRouters(sharedStore());
    await serveShellRequest(a, SHARED_URL);

    // Router B has captured nothing: its navigation finds no entry to replay.
    const cold = await serveShellRequest(b, SHARED_URL, { partial: true });
    expect({
      replay: cold.replayStatus,
      pages: shellServed(cold).pages,
    }).toEqual({
      replay: { outcome: "BYPASS", reason: "no-entry" },
      pages: ["app-b-page"],
    });

    const own = await serveShellRequest(a, SHARED_URL, { partial: true });
    expect({
      replay: own.replayStatus?.outcome,
      pages: shellServed(own).pages,
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
  function makePreview(routers: Record<App, TestRouter>) {
    const results: ServeShellRequestResult[] = [];
    const serve =
      (router: TestRouter) =>
      async (request: Request): Promise<Response> => {
        const result = await serveShellRequest(router, request.url, {
          headers: request.headers,
        });
        results.push(result);
        return new Response(result.body, result.response);
      };
    const host = createHostRouter({
      hostOverride: { cookieName: "app", allowedHosts: ["preview.dev"] },
    });
    host.host("a.internal").map(serve(routers.a));
    host.host("b.internal").map(serve(routers.b));
    return async (app: App) => {
      await host.match(
        new Request(PREVIEW_URL, {
          headers: { accept: "text/html", cookie: `app=${app}.internal` },
        }),
      );
      return shellServed(results.pop()!);
    };
  }

  it("one version: the second app's request is not a HIT with the first app's shell", async () => {
    setBuildVersions({ data: "d1", document: "h1" });
    const preview = makePreview(makeRouters(sharedStore()));

    expect(await preview("a")).toEqual(ownMiss("a"));
    expect(await preview("b")).toEqual(ownMiss("b"));

    expect(await preview("a")).toEqual(ownHit("a"));
    expect(await preview("b")).toEqual(ownHit("b"));
  });

  it("per-router versions: switching the cookie back and forth keeps both shells", async () => {
    setPerRouterVersions();
    const preview = makePreview(makeRouters(sharedStore()));

    expect(await preview("a")).toEqual(ownMiss("a"));
    expect(await preview("b")).toEqual(ownMiss("b"));
    expect(await preview("a")).toEqual(ownHit("a"));
    expect(await preview("b")).toEqual(ownHit("b"));
  });
});

describe("router.prerender() warm under another router's host", () => {
  const B_HOST_URL = "http://b.example/shelled";
  const served = async (router: TestRouter) =>
    shellServed(await serveShellRequest(router, B_HOST_URL));

  it("a shell one router warmed on a host is not served by the router that owns the host", async () => {
    setBuildVersions({ data: "d1", document: "h1" });
    const { a, b } = makeRouters(sharedStore());

    // Router B's host, resolved as router A's warm origin: what a route of B
    // calling A's runner with no `origin` does.
    const warmed = await a.prerender({ env: {} })(B_HOST_URL);
    expect(warmed).toMatchObject({ ok: true, status: "warmed" });
    expect(runs.b).toBe(0);

    expect(await served(b)).toEqual(ownMiss("b"));
    expect(runs.b).toBeGreaterThan(0);

    expect(await served(b)).toEqual(ownHit("b"));
    // The warm was not wasted: router A serves it where A is asked for it.
    expect(await served(a)).toEqual(ownHit("a"));
  });
});
