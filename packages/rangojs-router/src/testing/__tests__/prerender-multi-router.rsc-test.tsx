/**
 * `router.prerender()` with two routers in one process sharing one prerender
 * store and one cache store (an app behind a host router). A runner belongs to
 * the router it was called on: it matches only that router's routes, writes
 * entries keyed by that router's id and data version, and warms through that
 * router's own handler. Everything is served through `serveShellRequest`
 * (the production request handler); the host-router cases route the request
 * through `createHostRouter` first.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createMemoryPrerenderStore, setBuildVersions } from "../index.js";
import { createRouter, Prerender, urls } from "../../index.rsc.js";
import { createHostRouter } from "../../host/router.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import {
  serializePrerenderKey,
  type PrerenderKey,
} from "../../prerender/writable-store.js";
import { createKVPrerenderStore } from "../../prerender/cloudflare.js";
import type { WritablePrerenderStore } from "../../prerender/writable-store.js";

const A_HOST = "a.example.com";
const B_HOST = "b.example.com";

/** A store whose entries are visible to every location (a warm requires it). */
class SharedMemoryStore extends MemorySegmentCacheStore {
  readonly scope = "global" as const;
}

/** Producer and handler runs per router, to tell a stored render from a fresh one. */
const runs = {
  a: { producer: 0, shelled: 0 },
  b: { producer: 0, shelled: 0 },
};

function makeRouter(
  label: "a" | "b",
  shared: {
    prerender: WritablePrerenderStore;
    cache: SharedMemoryStore;
  },
  options: {
    onlyHere?: boolean;
    onRevalidate?: () => void;
  } = {},
) {
  const Article = Prerender<{ slug: string }>(
    async () => [],
    async (ctx) => {
      runs[label].producer += 1;
      return (
        <h1>{`${label}:${ctx.params.slug}:stamp-${runs[label].producer}`}</h1>
      );
    },
    { onDemand: { ttl: 3600, tags: ({ params }) => [`p:${params.slug}`] } },
  );
  function Shelled(): React.ReactNode {
    runs[label].shelled += 1;
    return <h1>{`${label}-shelled-${runs[label].shelled}`}</h1>;
  }
  return createRouter({
    id: `router-${label}`,
    cache: { store: shared.cache },
    prerender: {
      store: shared.prerender,
      ...(options.onRevalidate && { onRevalidate: options.onRevalidate }),
    },
  }).routes(
    urls(({ path }) => [
      path("/article/:slug", Article, { name: "article" }),
      path("/shelled", Shelled, { name: "shelled", ppr: true }),
      ...(options.onlyHere
        ? [path("/b-only", () => <p>only b</p>, { name: "bOnly" })]
        : []),
    ]),
  );
}

/** Keys the routers wrote, recorded at `set` so tests need not rebuild them. */
const written: PrerenderKey[] = [];

function track<T extends WritablePrerenderStore>(store: T): T {
  const set = store.set.bind(store);
  store.set = async (key, stored) => {
    written.push(key);
    return set(key, stored);
  };
  return store;
}

function keyFor(label: "a" | "b", version?: string): PrerenderKey {
  const found = [...written]
    .reverse()
    .find(
      (k) =>
        k.routerId === `router-${label}` && (!version || k.version === version),
    );
  if (!found) throw new Error(`no entry written for router-${label}`);
  return found;
}

describe("router.prerender() with two routers sharing stores", () => {
  let prerender: ReturnType<typeof createMemoryPrerenderStore>;
  let cache: SharedMemoryStore;
  let a: ReturnType<typeof makeRouter>;
  let b: ReturnType<typeof makeRouter>;

  beforeEach(async () => {
    await resetShellTestState();
    setBuildVersions({
      data: "all-d1",
      document: "all-h1",
      routers: {
        "router-a": { data: "a-d1", document: "a-h1" },
        "router-b": { data: "b-d1", document: "b-h1" },
      },
    });
    written.length = 0;
    prerender = track(createMemoryPrerenderStore());
    cache = new SharedMemoryStore();
    a = makeRouter("a", { prerender, cache });
    b = makeRouter("b", { prerender, cache });
    runs.a = { producer: 0, shelled: 0 };
    runs.b = { producer: 0, shelled: 0 };
  });

  afterEach(() => {
    setBuildVersions();
    vi.restoreAllMocks();
  });

  it("refreshing on A leaves B's entry for the same route and params untouched", async () => {
    // One data version for both routers: only the router id tells the keys apart.
    setBuildVersions({
      data: "all-d1",
      document: "all-h1",
      routers: {
        "router-a": { data: "shared-d1", document: "a-h1" },
        "router-b": { data: "shared-d1", document: "b-h1" },
      },
    });

    await b.prerender({ env: {} })("/article/x");
    expect(prerender.size).toBe(1);
    const bStored = prerender.peek(keyFor("b"))!;

    const result = await a.prerender({ env: {} })("/article/x");
    expect(result).toMatchObject({ ok: true, status: "rendered" });
    // A wrote its own key; B's envelope is the very object B stored.
    expect(prerender.size).toBe(2);
    expect(keyFor("a").version).toBe(keyFor("b").version);
    expect(prerender.peek(keyFor("b"))).toBe(bStored);

    // Refreshing A again re-renders A only.
    await a.prerender({ env: {} })("/article/x");
    expect(runs.a.producer).toBe(2);
    expect(runs.b.producer).toBe(1);
    expect(prerender.peek(keyFor("b"))).toBe(bStored);

    // Each router serves its own entry.
    expect((await serveShellRequest(a, "/article/x")).flight).toContain(
      "a:x:stamp-2",
    );
    expect((await serveShellRequest(b, "/article/x")).flight).toContain(
      "b:x:stamp-1",
    );
    expect(runs.a.producer).toBe(2);
    expect(runs.b.producer).toBe(1);
  });

  it("a URL only B has is no-match for A's runner", async () => {
    b = makeRouter("b", { prerender, cache }, { onlyHere: true });

    expect(await a.prerender({ env: {} })("/b-only")).toMatchObject({
      ok: false,
      status: "no-match",
    });
    // B's runner matches it and reaches the warm preconditions (no cache()).
    expect(
      await b.prerender({ env: {}, origin: `http://${B_HOST}` })("/b-only"),
    ).toMatchObject({ ok: false, status: "skipped-uncached" });
    expect(prerender.size).toBe(0);
  });

  it("a deploy that moves A's data version leaves B's refreshed entries served", async () => {
    const v1 = {
      "router-a": { data: "a-d1", document: "a-h1" },
      "router-b": { data: "b-d1", document: "b-h1" },
    };
    setBuildVersions({ data: "all-d1", document: "all-h1", routers: v1 });
    await a.prerender({ env: {} })("/article/x");
    await b.prerender({ env: {} })("/article/x");
    expect(prerender.peek(keyFor("a", "a-d1"))).not.toBeNull();
    expect(prerender.peek(keyFor("b", "b-d1"))).not.toBeNull();

    // A's server code changed; B's did not.
    setBuildVersions({
      data: "all-d2",
      document: "all-h2",
      routers: {
        "router-a": { data: "a-d2", document: "a-h2" },
        "router-b": v1["router-b"],
      },
    });
    const bServed = await serveShellRequest(b, "/article/x");
    expect(bServed.flight).toContain("b:x:stamp-1");
    expect(runs.b.producer).toBe(1);

    // A no longer reads the old-version entry: no live entry, so no match.
    expect((await serveShellRequest(a, "/article/x")).response.status).toBe(
      404,
    );

    // Refreshing A writes under A's new version and leaves B's alone.
    await a.prerender({ env: {} })("/article/x");
    expect(prerender.peek(keyFor("a", "a-d2"))).not.toBeNull();
    expect(prerender.peek(keyFor("b", "b-d1"))).not.toBeNull();
    expect((await serveShellRequest(b, "/article/x")).flight).toContain(
      "b:x:stamp-1",
    );
  });

  describe.each([
    ["memory store", () => createMemoryPrerenderStore()],
    [
      "KV store (one namespace)",
      () => {
        const map = new Map<string, string>();
        return createKVPrerenderStore({
          get: async (k) => map.get(k) ?? null,
          put: async (k, v) => void map.set(k, v),
          delete: async (k) => void map.delete(k),
        });
      },
    ],
  ])("markStale with a shared %s", (_name, createStore) => {
    it("on A does not mark B's entry for the same tag stale", async () => {
      const shared = track(createStore());
      const a = makeRouter("a", { prerender: shared, cache });
      const b = makeRouter("b", { prerender: shared, cache });
      await a.prerender({ env: {} })("/article/x");
      await b.prerender({ env: {} })("/article/x");
      const bStaleAt = (await shared.get(keyFor("b")))!.meta.staleAt;
      expect(bStaleAt).toBeGreaterThan(Date.now());

      await a.prerender({ env: {} }).markStale(["p:x"]);

      const aEntry = (await shared.get(keyFor("a")))!.meta;
      const bEntry = (await shared.get(keyFor("b")))!.meta;
      expect(aEntry.staleAt).toBeLessThanOrEqual(Date.now());
      // B keeps the staleAt its own ttl gave it.
      expect(bEntry.staleAt).toBe(bStaleAt);
    });
  });

  describe("serve path after markStale", () => {
    it("only the router that marked schedules onRevalidate", async () => {
      const onA = vi.fn();
      const onB = vi.fn();
      a = makeRouter("a", { prerender, cache }, { onRevalidate: onA });
      b = makeRouter("b", { prerender, cache }, { onRevalidate: onB });
      await a.prerender({ env: {} })("/article/x");
      await b.prerender({ env: {} })("/article/x");

      await a.prerender({ env: {} }).markStale(["p:x"]);
      await serveShellRequest(a, "/article/x");
      await serveShellRequest(b, "/article/x");

      expect(onA).toHaveBeenCalledTimes(1);
      expect(onB).not.toHaveBeenCalled();
    });

    it("onlyIfStale renders the marked router and reports already-fresh for the other", async () => {
      await a.prerender({ env: {} })("/article/x");
      await b.prerender({ env: {} })("/article/x");
      await a.prerender({ env: {} }).markStale(["p:x"]);

      expect(
        await a.prerender({ env: {} })("/article/x", { onlyIfStale: true }),
      ).toMatchObject({ ok: true, status: "rendered" });
      expect(
        await b.prerender({ env: {} })("/article/x", { onlyIfStale: true }),
      ).toMatchObject({ ok: true, status: "already-fresh" });
      expect(runs.a.producer).toBe(2);
      expect(runs.b.producer).toBe(1);
    });
  });

  describe("behind a host router", () => {
    function hostApp(
      a: ReturnType<typeof makeRouter>,
      b: ReturnType<typeof makeRouter>,
    ) {
      const served: Record<
        string,
        Awaited<ReturnType<typeof serveShellRequest>> | null
      > = { a: null, b: null };
      const through =
        (label: "a" | "b", router: ReturnType<typeof makeRouter>) =>
        async (request: Request): Promise<Response> => {
          const result = await serveShellRequest(router, request.url);
          served[label] = result;
          return new Response(result.body, {
            status: result.response.status,
            headers: result.response.headers,
          });
        };
      const hostRouter = createHostRouter();
      hostRouter.host(A_HOST).map(through("a", a));
      hostRouter.host(B_HOST).map(through("b", b));
      return {
        served,
        get: async (host: string, path: string) =>
          hostRouter.match(new Request(`http://${host}${path}`), {
            env: {},
            ctx: { waitUntil() {}, passThroughOnException() {} } as any,
          }),
      };
    }

    it("a warm for A's host is a HIT through the host router for A's host, a MISS for B's", async () => {
      const app = hostApp(a, b);

      const result = await a.prerender({ env: {} })(`http://${A_HOST}/shelled`);
      expect(result).toMatchObject({ ok: true, status: "warmed" });
      const warmedRuns = runs.a.shelled;
      expect(warmedRuns).toBeGreaterThan(0);

      await app.get(A_HOST, "/shelled");
      expect(app.served.a?.shellStatus).toBe("HIT");
      expect(app.served.b).toBeNull();
      expect(runs.a.shelled).toBe(warmedRuns);

      await app.get(B_HOST, "/shelled");
      expect(app.served.b?.shellStatus).toBe("MISS");
      expect(runs.b.shelled).toBeGreaterThan(0);
    });

    it("a warm with the wrong host (the origin option) does not serve A's own host", async () => {
      const app = hostApp(a, b);

      // The runner's `origin` is the host the warm requests: cache keys carry it.
      await a.prerender({ env: {}, origin: `http://${B_HOST}` })("/shelled");

      // A's warm wrote a shell under B's host. The shell key has no router id
      // (#1065); only the per-router versions keep B from serving it here.
      await app.get(B_HOST, "/shelled");
      expect(app.served.b?.shellStatus).toBe("MISS");

      await app.get(A_HOST, "/shelled");
      expect(app.served.a?.shellStatus).toBe("MISS");
      await app.get(A_HOST, "/shelled");
      expect(app.served.a?.shellStatus).toBe("HIT");
    });

    it("an on-demand refresh on A is served through the host router for A's host only", async () => {
      const app = hostApp(a, b);

      await a.prerender({ env: {}, origin: `http://${A_HOST}` })("/article/x");

      await app.get(A_HOST, "/article/x");
      expect(app.served.a?.flight).toContain("a:x:stamp-1");
      expect(runs.a.producer).toBe(1);

      // B's host reaches B, which has no entry: its handler renders live.
      await app.get(B_HOST, "/article/x");
      expect(app.served.b?.response.status).toBe(404);
    });
  });
});
