/**
 * An error in the background re-render of a cache() record (a stale HIT's
 * refresh, a navigation MISS's proactive write) reaches `onError` with the
 * `isPartial` of the request that started it, as that request's own walk
 * reports it: `true` for a navigation, unset for a document. The re-render
 * is a full-match pass whatever started it, so it used to report every error
 * unset, a navigation's included.
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
import { createRouter, urls, type OnErrorContext } from "../../index.rsc.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";

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

/** The real clock, moved forward by hand. */
function movableClock(): { advance: (ms: number) => void } {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  return { advance: (ms) => (offset += ms) };
}

let layoutThrows = false;

function Layout(): React.ReactNode {
  if (layoutThrows) throw new Error("layout failed");
  return <main>shell</main>;
}

type Reported = Pick<OnErrorContext, "phase" | "segmentType" | "isPartial">;
const reported: Reported[] = [];

const router = createRouter({
  onError: (ctx) => {
    if (ctx.error.message !== "layout failed") return;
    reported.push({
      phase: ctx.phase,
      segmentType: ctx.segmentType,
      isPartial: ctx.isPartial,
    });
  },
}).routes(
  urls(({ path, cache, layout, intercept }) => [
    // Stale from the start, servable for 60 s.
    cache({ ttl: 0, swr: 60 }, () => [
      layout(Layout, () => [
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/item/:id", () => <article>item</article>, { name: "item" }),
        path("/photo/:id", () => <figure>photo</figure>, { name: "photo" }),
        intercept("@modal", ".photo", () => <dialog>modal</dialog>),
      ]),
    ]),
  ]),
);

const LAYOUT_ERROR = { phase: "handler", segmentType: "layout" } as const;

describe("onError's isPartial for an error in a cache() record's background re-render", () => {
  let cacheStore: VercelCacheStore;
  let clock: { advance: (ms: number) => void };

  beforeEach(async () => {
    await resetShellTestState();
    layoutThrows = false;
    reported.length = 0;
    cacheStore = new VercelCacheStore({ cache: vercelCache() });
    clock = movableClock();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The ids a client on /list holds, from a navigation that renders it. */
  async function listSegments(): Promise<string[]> {
    const list = await serveShellRequest(router, "/list", {
      cacheStore,
      partial: true,
    });
    const { metadata } = await deserializeResult<{
      metadata: { matched: string[] };
    }>(list.flight!);
    return metadata.matched;
  }

  /** Serve `serve` once to write the record, then stale with the layout failing. */
  async function staleHit(serve: () => Promise<unknown>): Promise<void> {
    await serve();
    expect(reported).toEqual([]);
    clock.advance(1_100);
    layoutThrows = true;
    await serve();
  }

  describe("in the foreground (unchanged)", () => {
    it("a document reports it unset", async () => {
      layoutThrows = true;
      await serveShellRequest(router, "/list", { cacheStore });
      expect(reported).toStrictEqual([
        { ...LAYOUT_ERROR, isPartial: undefined },
      ]);
    });

    it("a navigation reports it true", async () => {
      layoutThrows = true;
      await serveShellRequest(router, "/list", { cacheStore, partial: true });
      expect(reported).toStrictEqual([{ ...LAYOUT_ERROR, isPartial: true }]);
    });
  });

  describe("in a stale HIT's refresh", () => {
    it("started by a document, reports it unset, as the document does", async () => {
      await staleHit(() => serveShellRequest(router, "/list", { cacheStore }));
      expect(reported).toStrictEqual([
        { ...LAYOUT_ERROR, isPartial: undefined },
      ]);
    });

    it("started by a navigation whose client holds nothing, reports it true", async () => {
      await staleHit(() =>
        serveShellRequest(router, "/item/1", { cacheStore, partial: true }),
      );
      expect(reported).toStrictEqual([{ ...LAYOUT_ERROR, isPartial: true }]);
    });

    it("started by a navigation whose client holds the layout, reports it true", async () => {
      const segments = await listSegments();
      await staleHit(() =>
        serveShellRequest(router, "/item/1", {
          cacheStore,
          partial: { from: "/list", segments },
        }),
      );
      expect(reported).toStrictEqual([{ ...LAYOUT_ERROR, isPartial: true }]);
    });

    it("started by an intercept navigation, reports it true", async () => {
      const segments = await listSegments();
      await staleHit(async () => {
        const { flight } = await serveShellRequest(router, "/photo/1", {
          cacheStore,
          partial: { from: "/list", segments },
        });
        expect(flight).toContain("modal");
      });
      expect(reported).toStrictEqual([{ ...LAYOUT_ERROR, isPartial: true }]);
    });
  });

  it("in a navigation MISS's proactive write (the client holds the layout), reports it true", async () => {
    const segments = await listSegments();
    layoutThrows = true;
    const { flight } = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: { from: "/list", segments },
    });
    // The client holds the layout: only the re-render runs it.
    expect(flight).toContain("item");
    expect(reported).toStrictEqual([{ ...LAYOUT_ERROR, isPartial: true }]);
  });
});
