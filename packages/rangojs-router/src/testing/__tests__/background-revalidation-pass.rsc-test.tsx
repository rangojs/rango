/**
 * The background re-render of a stale cache() record
 * (router/match-middleware/background-revalidation.ts rerenderAndCacheRoute)
 * writes a route record under cache() rules, whoever read the record stale.
 *
 * - A PPR shell capture that reads the record stale starts the refresh too.
 *   It used to render under the capture's identity guard, so a loader body's
 *   headers(), which cache() allows, failed the refresh, and every recapture
 *   replayed the stale record until it expired.
 * - The refresh runs no DSL loader, so it never reads the visitor's render
 *   barrier: the visitor's rendered() reads the handles the HIT replayed,
 *   and the refreshed record carries the refresh's own.
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
import {
  createHandle,
  createLoader,
  createRouter,
  headers,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  CFCacheStore,
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";

let generation = 1;

function vercelCache(): VercelRuntimeCache {
  const values = new Map<string, unknown>();
  return {
    async get(key) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag() {},
  };
}

/** A Workers edge cache double, as `caches.default`. */
function stubEdgeCache(): void {
  const entries = new Map<string, Response>();
  const edge = {
    async match(request: Request) {
      return entries.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      entries.set(request.url, response.clone());
    },
    async delete(request: Request) {
      return entries.delete(request.url);
    },
  };
  vi.stubGlobal("caches", { default: edge, open: async () => edge });
}

/** A KV namespace double (string values). */
function kv() {
  const values = new Map<string, string>();
  return {
    async get(key: string, options?: { type?: string }) {
      const value = values.get(key);
      if (value === undefined) return null;
      return options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

/** The real clock, moved forward by hand. */
function movableClock(): { advance: (ms: number) => void } {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  return { advance: (ms) => (offset += ms) };
}

const Stamp = createHandle<string>();

const StampReader = createLoader(async (ctx) => {
  await ctx.rendered();
  return { read: `read:${ctx.get(Stamp).join(",")}` };
});

/** Forwards a request header to its backend; the data is the same for all. */
const ForwardingLoader = createLoader(async () => {
  void headers().get("traceparent");
  return { generation };
});

function StampPage(ctx: HandlerContext): React.ReactNode {
  ctx.use(Stamp)(`stamp@g${generation}`);
  return <p>{`page@g${generation}`}</p>;
}

async function ForwardingPage(ctx: HandlerContext): Promise<React.ReactNode> {
  const data = await ctx.use(ForwardingLoader);
  return <p>{`forwarding@g${data.generation}`}</p>;
}

const routes = urls(({ path, cache, loader }) => [
  // Stale from the start, servable for 60 s.
  cache({ ttl: 0, swr: 60 }, () => [
    path("/stamp", StampPage, { name: "stamp" }, () => [loader(StampReader)]),
    path("/forwarding", ForwardingPage, { name: "forwarding", ppr: true }),
  ]),
]);

const router = createRouter({}).routes(routes);

/** The store built per request from the router's cache config, as on Workers. */
const cfRouter = createRouter({
  cache: (env: { KV: any }, ctx) => ({
    store: new CFCacheStore({ ctx: ctx!, kv: env.KV, memo: { shellMs: 0 } }),
  }),
}).routes(routes);

describe("a stale cache() record's background re-render", () => {
  beforeEach(async () => {
    await resetShellTestState();
    generation = 1;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("leaves the visitor's render barrier alone: rendered() reads the replayed handles, the refreshed record carries the refresh's", async () => {
    const clock = movableClock();
    const cacheStore = new VercelCacheStore({ cache: vercelCache() });
    const serve = async () =>
      (await serveShellRequest(router, "/stamp", { cacheStore })).flight?.match(
        /page@g\d|read:[^"]*/g,
      );

    expect(await serve()).toEqual(["page@g1", "read:stamp@g1"]);
    generation = 2;
    clock.advance(1_100);
    expect(await serve()).toEqual(["page@g1", "read:stamp@g1"]);
    clock.advance(1_100);
    expect(await serve()).toEqual(["page@g2", "read:stamp@g2"]);
  });

  it("started by a shell recapture, refreshes under cache() rules: a loader body's headers() does not fail it", async () => {
    const clock = movableClock();
    stubEdgeCache();
    const env = { KV: kv() };
    const serve = () => serveShellRequest(cfRouter, "/forwarding", { env });

    expect((await serve()).shellStatus).toBe("MISS");
    generation = 2;
    const shown: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(1_100);
      const hit = await serve();
      shown.push(`${hit.shellStatus} ${hit.prelude?.match(/@g\d/)?.[0]}`);
    }

    // A stale shell HIT recaptures; the recapture replays the stale record
    // and refreshes it, and the next recapture replays the refresh.
    expect(shown).toEqual(["HIT @g1", "HIT @g1", "HIT @g2"]);
  });
});
