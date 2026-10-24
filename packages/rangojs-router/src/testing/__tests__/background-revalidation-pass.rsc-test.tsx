/**
 * The background re-render of a stale cache() record
 * (router/match-middleware/background-revalidation.ts rerenderAndCacheRoute)
 * writes a route record under cache() rules, whoever read the record stale.
 *
 * - A PPR shell capture that reads the record stale starts the refresh too.
 *   It used to render under the capture's identity guard, so a loader body's
 *   headers(), which cache() allows, failed the refresh, and every recapture
 *   replayed the stale record until it expired. Its handler's dynamic()
 *   wrote the capture's latch and refused the capture, which had replayed
 *   the record as a fresh HIT's capture does and stores.
 * - The refresh inherits the visitor's render barrier, resolved before the
 *   pass starts (a stale HIT resolves it before the refresh, proactive
 *   caching runs from onResponse). Its route and intercept passes skip DSL
 *   loaders, so an open intercept's loader that calls rendered() and that
 *   nothing reads never runs there; cacheRoute drops loader segments and
 *   captureHandles loader pushes, so no loader's read reaches the record. A
 *   shell capture never takes the intercept branch: its request drops the
 *   intercept source.
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
import { deserializeResult } from "../../cache/segment-codec.js";

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

let modalRuns = 0;
/** Every ModalReader run's read, once past rendered(). */
const modalReads: string[] = [];

/** Tags its read with its run, so a read shown can be traced to its pass. */
const ModalReader = createLoader(async (ctx) => {
  const run = ++modalRuns;
  await ctx.rendered();
  const read = `read:${ctx.get(Stamp).join(",")}#${run}`;
  modalReads.push(read);
  return { read };
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

/** Every run opts its render off the shell axis; a cache() HIT runs none. */
function LivePage(ctx: HandlerContext): React.ReactNode {
  ctx.dynamic();
  return <p>{`live@g${generation}`}</p>;
}

function StampLayout(ctx: HandlerContext): React.ReactNode {
  ctx.use(Stamp)(`stamp@g${generation}`);
  return <main>shell</main>;
}

/** A HIT sends the intercept's push; the held layout's stays the client's. */
function StampModal(ctx: HandlerContext): React.ReactNode {
  ctx.use(Stamp)(`stamp@g${generation}`);
  return <dialog>modal</dialog>;
}

const routes = urls(({ path, cache, layout, intercept, loader }) => [
  // Stale from the start, servable for 60 s.
  cache({ ttl: 0, swr: 60 }, () => [
    path("/stamp", StampPage, { name: "stamp" }, () => [loader(StampReader)]),
    path("/forwarding", ForwardingPage, { name: "forwarding", ppr: true }),
    path("/live", LivePage, { name: "live", ppr: true }),
    layout(StampLayout, () => [
      path("/list", () => <ul>list</ul>, { name: "list" }),
      path("/item/:id", () => <article>item</article>, { name: "item" }),
      intercept("@modal", ".item", StampModal, () => [loader(ModalReader)]),
    ]),
  ]),
  cache({ ttl: 60 }, () => [
    path("/live-fresh", LivePage, { name: "liveFresh", ppr: true }),
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
    modalRuns = 0;
    modalReads.length = 0;
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

  it("refreshing an open intercept runs none of its loaders, and the next HIT's run reads the refreshed record's handles", async () => {
    const clock = movableClock();
    const cacheStore = new VercelCacheStore({ cache: vercelCache() });
    const list = await serveShellRequest(router, "/list", {
      cacheStore,
      partial: true,
    });
    const { metadata } = await deserializeResult<{
      metadata: { matched: string[] };
    }>(list.flight!);
    // Opens the modal over /list, whose layout the client holds.
    const open = async () => {
      const before = modalReads.length;
      const { flight } = await serveShellRequest(router, "/item/1", {
        cacheStore,
        partial: { from: "/list", segments: metadata.matched },
      });
      return {
        shown: flight?.match(/read:[^"]*/g),
        ran: modalReads.slice(before),
      };
    };

    // The client holds the layout, so the MISS writes the record by a
    // re-render (proactive caching), which runs no loader: the visitor's run
    // is the only one.
    const miss = await open();
    expect(miss.ran).toHaveLength(1);
    expect(miss.shown).toEqual([expect.stringMatching(/^read:#\d+$/)]);
    expect(miss.ran).toContain(miss.shown![0]);

    // The stale HIT replays the intercept's stamp@g1, not the held layout's,
    // and refreshes the record at g2 without running the loader: the
    // visitor's run reads the replayed handles.
    generation = 2;
    clock.advance(1_100);
    const staleHit = await open();
    expect(staleHit.ran).toHaveLength(1);
    expect(staleHit.shown).toEqual([
      expect.stringMatching(/^read:stamp@g1#\d+$/),
    ]);
    expect(staleHit.ran).toContain(staleHit.shown![0]);

    // The next HIT replays the refreshed record's handles, and its own run
    // reads them.
    clock.advance(1_100);
    const refreshedHit = await open();
    expect(refreshedHit.ran).toHaveLength(1);
    expect(refreshedHit.shown).toEqual([
      expect.stringMatching(/^read:stamp@g2#\d+$/),
    ]);
    expect(refreshedHit.ran).toContain(refreshedHit.shown![0]);
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

  it("started by a shell recapture, a cached handler's dynamic() leaves the capture alone: a stale read captures as a fresh one does", async () => {
    const clock = movableClock();
    stubEdgeCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const serveEach = async (url: string, requests: number) => {
      const env = { KV: kv() };
      const shown: string[] = [];
      for (let i = 1; i <= requests; i++) {
        generation = i;
        const r = await serveShellRequest(cfRouter, url, { env });
        const body = r.prelude ?? r.flight;
        shown.push(`${r.shellStatus} ${body?.match(/live@g\d/)?.[0]}`);
        clock.advance(1_100);
      }
      return shown;
    };

    // The first render runs the handler: its dynamic() keeps that MISS off
    // the shell axis. The next reads the record and runs no handler, so its
    // capture stores the shell.
    expect(await serveEach("/live-fresh", 3)).toEqual([
      "null live@g1",
      "MISS live@g1",
      "HIT live@g1",
    ]);
    // A stale read's refresh runs the handler for the record, not the shell:
    // each recapture stores the shell and replays the last refresh.
    expect(await serveEach("/live", 6)).toEqual([
      "null live@g1",
      "MISS live@g1",
      "HIT live@g2",
      "HIT live@g2",
      "HIT live@g3",
      "HIT live@g4",
    ]);
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("was refused")),
    ).toEqual([]);
  });
});
