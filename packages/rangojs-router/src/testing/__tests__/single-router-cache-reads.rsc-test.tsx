/**
 * One router, one cache store (issue #1065): the router part of a cache key
 * is a prefix on a key the request already builds, so a single-router app
 * makes the store reads it made before, no more. The counts below are the
 * ones measured on the commit before the keys carried a router.
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
import { dispatch } from "../index.js";
import { createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { makeRouter } from "./helpers/two-router-fixture.js";

const READS = ["getShell", "get", "getResponse"] as const;
type Read = (typeof READS)[number];
type ReadCounts = Record<Read, number>;

function setup() {
  const store = new MemorySegmentCacheStore();
  const spies: Record<
    Read,
    { mock: { calls: unknown[][] }; mockClear(): void }
  > = {
    getShell: vi.spyOn(store, "getShell"),
    get: vi.spyOn(store, "get"),
    getResponse: vi.spyOn(store, "getResponse"),
  };
  const router = makeRouter("a", store);

  /** The reads since the last call, and the keys they asked for. */
  const take = (): { counts: ReadCounts; keys: string[] } => {
    const counts = {} as ReadCounts;
    const keys: string[] = [];
    for (const read of READS) {
      counts[read] = spies[read].mock.calls.length;
      keys.push(...spies[read].mock.calls.map(([key]) => String(key)));
      spies[read].mockClear();
    }
    return { counts, keys };
  };
  return { router, take };
}

beforeEach(async () => {
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a single router: the key's router part adds no store read", () => {
  it("a ppr route: document MISS with its capture, document HIT, navigation replay", async () => {
    const { router, take } = setup();

    const miss = await serveShellRequest(router, "/shelled");
    expect(miss.shellStatus).toBe("MISS");
    expect(take().counts).toEqual({ getShell: 1, get: 1, getResponse: 0 });

    const hit = await serveShellRequest(router, "/shelled");
    expect(hit.shellStatus).toBe("HIT");
    expect(take().counts).toEqual({ getShell: 1, get: 0, getResponse: 0 });

    const nav = await serveShellRequest(router, "/shelled", { partial: true });
    expect(nav.replayStatus?.outcome).toBe("HIT");
    expect(take().counts).toEqual({ getShell: 1, get: 0, getResponse: 0 });
  });

  it("a cache() route: record miss, then record hit", async () => {
    const { router, take } = setup();

    await serveShellRequest(router, "/cached");
    expect(take().counts).toEqual({ getShell: 0, get: 1, getResponse: 0 });

    await serveShellRequest(router, "/cached");
    expect(take().counts).toEqual({ getShell: 0, get: 1, getResponse: 0 });
  });

  it("a document-cache response and a response route: one read each", async () => {
    const { router, take } = setup();

    await serveShellRequest(router, "/stored");
    expect(take().counts).toEqual({ getShell: 0, get: 0, getResponse: 1 });
    const stored = await serveShellRequest(router, "/stored");
    expect(stored.response.headers.get("x-document-cache-status")).toBe("HIT");
    expect(take().counts).toEqual({ getShell: 0, get: 0, getResponse: 1 });

    await dispatch(router, { request: "/api/data" });
    expect(take().counts).toEqual({ getShell: 0, get: 0, getResponse: 1 });
  });

  it("every key read names the router", async () => {
    const { router, take } = setup();

    await serveShellRequest(router, "/shelled");
    await serveShellRequest(router, "/shelled", { partial: true });
    await serveShellRequest(router, "/cached");
    await serveShellRequest(router, "/stored");
    await dispatch(router, { request: "/api/data" });

    const { keys } = take();
    expect(keys.length).toBeGreaterThan(0);
    expect(
      keys.filter((key) => !key.includes(`${router.id}@localhost/`)),
    ).toEqual([]);
  });
});

// A createRouter() the id transform cannot reach (an options variable) runs
// on the `router_{n}` counter, and a dev server re-evaluating that module
// counts on: the same router comes back under a new id. Vitest runs no
// transform, so every router here is on the counter.
describe("a router module re-evaluated on the counter fallback id", () => {
  function makeCounterRouter(
    store: MemorySegmentCacheStore,
    runs: { page: number },
  ) {
    return createRouter({ cache: { store } }).routes(
      urls(({ path }) => [
        path(
          "/shelled",
          () => {
            runs.page += 1;
            return <h1>shelled-page</h1>;
          },
          { name: "shelled", ppr: true },
        ),
      ]),
    );
  }

  it("costs one recapture: the new instance misses once, then serves its own shell", async () => {
    const store = new MemorySegmentCacheStore();
    const runs = { page: 0 };
    const before = makeCounterRouter(store, runs);
    const captured = await serveShellRequest(before, "/shelled");
    expect((await serveShellRequest(before, "/shelled")).shellStatus).toBe(
      "HIT",
    );

    const after = makeCounterRouter(store, runs);
    expect([before.id, after.id]).toEqual([
      expect.stringMatching(/^router_\d+$/),
      expect.stringMatching(/^router_\d+$/),
    ]);
    expect(after.id).not.toBe(before.id);

    runs.page = 0;
    const miss = await serveShellRequest(after, "/shelled");
    expect(miss.shellStatus).toBe("MISS");
    expect(miss.body).toContain("shelled-page");
    expect(runs.page).toBeGreaterThan(0);
    expect((await serveShellRequest(after, "/shelled")).shellStatus).toBe(
      "HIT",
    );

    // The old id's entry is not rewritten or dropped: it runs out on its ttl.
    expect(miss.key).not.toBe(captured.key);
    expect(await captured.readEntry()).not.toBeNull();
  });
});
