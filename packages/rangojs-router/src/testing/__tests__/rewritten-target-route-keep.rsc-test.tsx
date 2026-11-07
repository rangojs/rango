/**
 * A navigation to a URL middleware rewrites, from the page the rewrite
 * renders: /rw/deals renders /rw/en/p/1. The target's route params and
 * search equal the source's, but the visitor's URL moved, and the render may
 * read `ctx.rewrittenFrom`. The route segment is sent, as it is leaving a
 * rewritten page (router/match-api.ts `_visitorMoved`). Kept by default, the
 * answer would hang on the source's params with nothing marking it
 * (router/source-reads.ts prefetchScopeOf): the browser's prefetch cache and
 * the document cache would share it with every page holding the same ids,
 * and /rw/en/p/2 would keep product 2 at /rw/deals.
 *
 * Through the public serveShellRequest primitive, the browser's prefetch
 * cache and commit (helpers/prefetch-browser.ts), and
 * createDocumentCacheMiddleware.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  createRouter,
  rewrite,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  createDocumentCacheMiddleware,
  MemorySegmentCacheStore,
} from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { ResolvedSegment } from "../../types.js";
import {
  createPrefetchBrowser,
  renderedTree,
  type Serve,
} from "./helpers/prefetch-browser.js";

const product = (ctx: HandlerContext<any>): string =>
  `product:${ctx.params.id} from:${ctx.rewrittenFrom?.pathname ?? "-"}`;

/**
 * A held chrome layout, and an offers layout that re-renders on every
 * navigation, over a product route and /rw/deals, which rewrites to product
 * 1. With `documentCache`, the offers layout and the product opt into it, so
 * an answer that keeps the product and sends the offers is stored.
 */
function app({ documentCache = false }: { documentCache?: boolean } = {}) {
  const cacheStore = new MemorySegmentCacheStore();
  const base = createRouter({ prefetchCacheTTL: false });
  const cacheable = (ctx: HandlerContext<any>): void => {
    if (documentCache) ctx.headers.set("Cache-Control", "s-maxage=60");
  };
  const router = (
    documentCache ? base.use(createDocumentCacheMiddleware()) : base
  ).routes(
    urls(({ layout, middleware, path, revalidate }) => [
      layout(
        () => <main>chrome</main>,
        () => [
          layout(
            (ctx) => {
              cacheable(ctx);
              return <aside>offers</aside>;
            },
            () => [
              revalidate(() => true),
              path(
                "/rw/:locale/p/:id",
                (ctx) => {
                  cacheable(ctx);
                  return <p>{product(ctx)}</p>;
                },
                { name: "product" },
              ),
              path(
                "/rw/deals",
                () => <p>deals</p>,
                { name: "deals" },
                () => [
                  middleware(() => {
                    throw rewrite("/rw/en/p/1");
                  }),
                ],
              ),
            ],
          ),
        ],
      ),
    ]),
  );
  const serve: Serve = (url, options) =>
    serveShellRequest(router, url, { cacheStore, ...options });
  return { serve };
}

interface Metadata {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
}

async function metadataOf(result: ServeShellRequestResult): Promise<Metadata> {
  return (await deserializeResult<{ metadata: Metadata }>(result.flight!))
    .metadata;
}

const productsOn = async (segments: ResolvedSegment[]): Promise<string[]> =>
  (await renderedTree(segments))
    .map((line) => /product:\d+ from:\S+?(?=<)/.exec(line)?.[0])
    .filter((line): line is string => line !== undefined);

beforeEach(async () => {
  await resetShellTestState();
});

describe("a navigation to a rewritten URL from the page it renders", () => {
  it("the route is rendered for the visitor's URL: ctx.rewrittenFrom names it", async () => {
    const { serve } = app();
    const tab = createPrefetchBrowser(serve);
    const loaded = await tab.load("/rw/en/p/1");
    expect(await productsOn(loaded.segments)).toEqual(["product:1 from:-"]);

    const { screen } = await tab.click("/rw/deals");
    expect(await productsOn(screen.segments)).toEqual([
      "product:1 from:/rw/deals",
    ]);
  });

  it("a prefetch made on /rw/en/p/1 and clicked from /rw/en/p/2 shows product 1 at /rw/deals", async () => {
    const { serve } = app();
    const tab = createPrefetchBrowser(serve);
    await tab.load("/rw/en/p/1");
    await tab.prefetch("/rw/deals");

    const p2 = await tab.click("/rw/en/p/2");
    expect(await productsOn(p2.screen.segments)).toEqual(["product:2 from:-"]);
    const deals = await tab.click("/rw/deals");
    expect(await productsOn(deals.screen.segments)).toEqual([
      "product:1 from:/rw/deals",
    ]);
  });

  it("the document cache, keyed by URL and ids, serves /rw/en/p/2 an answer that sends product 1", async () => {
    const { serve } = app({ documentCache: true });
    const held = async (at: string): Promise<string[]> =>
      (await metadataOf(await serve(at, { partial: { from: "/elsewhere" } })))
        .matched;
    const p1 = await held("/rw/en/p/1");
    const p2 = await held("/rw/en/p/2");
    expect(p2).toEqual(p1);

    const fromP1 = await serve("/rw/deals", {
      partial: { from: "/rw/en/p/1", segments: p1 },
    });
    const fromP2 = await serve("/rw/deals", {
      partial: { from: "/rw/en/p/2", segments: p2 },
    });
    // The answer sent from the hat is stored under /rw/deals and the ids
    // both pages hold, and answers /rw/en/p/2.
    expect(fromP2.response.headers.get("x-document-cache-status")).toBe("HIT");
    const productId = p1.at(-1)!;
    const answer = await metadataOf(fromP2);
    expect(answer.diff).toContain(productId);
    // A render the document cache stores sees no visitor URL.
    expect(await productsOn(answer.segments)).toEqual(["product:1 from:-"]);
    expect((await metadataOf(fromP1)).diff).toContain(productId);
  });

  it("a navigation from /rw/deals to /rw/deals keeps the route: the visitor's URL did not move", async () => {
    const { serve } = app();
    const loaded = await metadataOf(
      await serve("/rw/deals", { partial: { from: "/elsewhere" } }),
    );
    const again = await metadataOf(
      await serve("/rw/deals", {
        partial: {
          from: "/rw/deals",
          rewriteTarget: "/rw/en/p/1",
          segments: loaded.matched,
        },
      }),
    );
    expect(again.diff).not.toContain(loaded.matched.at(-1));
  });
});
