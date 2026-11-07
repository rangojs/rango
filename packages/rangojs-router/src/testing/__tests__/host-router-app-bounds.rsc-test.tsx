/**
 * A document served under createHostRouter() tells the browser which paths of
 * its origin are its app's, through the public testing primitives. The
 * browser sends a link outside them straight to a document navigation
 * (browser/app-bounds.ts), so the bounds must reach every document the app
 * serves: a render, a PPR shell HIT and a 404.
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
  shellServed,
  type TestRouter,
} from "./helpers/two-router-fixture.js";

/** The `appBounds` value of a document's Flight payload, or undefined. */
function appBoundsIn(flight: string | undefined): unknown {
  const key = '"appBounds":';
  const start = flight?.indexOf(key) ?? -1;
  if (!flight || start === -1) return undefined;
  let depth = 0;
  for (let i = start + key.length; i < flight.length; i++) {
    if (flight[i] === "[") depth++;
    if (flight[i] === "]" && --depth === 0) {
      return JSON.parse(flight.slice(start + key.length, i + 1));
    }
  }
  throw new Error("unterminated appBounds");
}

/**
 * One origin, two apps: app A mounted at /shelled, app B everywhere else on
 * `shop.test`, and app B alone on `b.test`.
 */
function makeHost(routers: { a: TestRouter; b: TestRouter }) {
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
  const host = createHostRouter();
  host.host(["shop.test/shelled"]).map(serve(routers.a));
  host.host(["shop.test", "b.test"]).map(serve(routers.b));
  return async (url: string): Promise<ServeShellRequestResult> => {
    await host.match(new Request(url, { headers: { accept: "text/html" } }));
    return results.pop()!;
  };
}

beforeEach(async () => {
  await resetShellTestState();
  setBuildVersions({ data: "d1", document: "h1" });
  resetRuns();
});

afterEach(() => {
  setBuildVersions();
  vi.restoreAllMocks();
});

describe("createHostRouter(): a document names the paths its app owns", () => {
  it("a path-mounted app owns its prefix, on a MISS and on the HIT after it", async () => {
    const visit = makeHost(makeRouters(memoryStore().cacheStore));

    const miss = await visit("http://shop.test/shelled");
    expect(shellServed(miss)).toEqual(ownMiss("a"));
    expect(appBoundsIn(miss.flight)).toEqual([[["/shelled", true]]]);

    // A HIT renders its tail's payload per request: the bounds are this
    // request's, not the capture's.
    const hit = await visit("http://shop.test/shelled");
    expect(shellServed(hit)).toEqual(ownHit("a"));
    expect(appBoundsIn(hit.flight)).toEqual([[["/shelled", true]]]);
  });

  it("the catch-all app owns every path but the mount before it, 404 included", async () => {
    const visit = makeHost(makeRouters(memoryStore().cacheStore));
    const owned = [
      [
        ["/shelled", false],
        ["", true],
      ],
    ];

    const page = await visit("http://shop.test/cached");
    expect(page.body).toContain("app-b-cached");
    expect(appBoundsIn(page.flight)).toEqual(owned);

    const notFound = await visit("http://shop.test/missing");
    expect(notFound.response.status).toBe(404);
    expect(appBoundsIn(notFound.flight)).toEqual(owned);
  });

  it("an app that owns every path of its host sends no bounds", async () => {
    const visit = makeHost(makeRouters(memoryStore().cacheStore));

    const page = await visit("http://b.test/cached");
    expect(page.body).toContain("app-b-cached");
    expect(page.flight).toBeDefined();
    expect(page.flight).not.toContain('"appBounds"');
  });

  it("a router served without a host router sends no bounds", async () => {
    const { b } = makeRouters(memoryStore().cacheStore);

    const page = await serveShellRequest(b, "http://shop.test/cached");
    expect(page.flight).toBeDefined();
    expect(page.flight).not.toContain('"appBounds"');
  });
});
