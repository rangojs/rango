/**
 * rango-t238: the document cache keys a partial by its URL and the ids the
 * client holds, not by the page it is sent from. A partial whose diff
 * depends on the source page (one the browser's prefetch cache scopes with
 * `x-rsc-prefetch-scope`: a revalidate() rule that read the source and kept
 * a segment, an intercept that targets the route) is not stored, so a page
 * with the same ids is never served another page's diff. Through the public
 * serveShellRequest primitive, with createDocumentCacheMiddleware in front.
 *
 * The shape is the ticket's: a category layout above /c/:category renders
 * the category's hero and re-renders when the category changes. From
 * /c/audio, /c/audio?sort=x keeps the hero; from /c/tv it must render the
 * audio hero. Both pages hold the same segment ids.
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
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { createRouter, urls, type HandlerContext } from "../../index.rsc.js";
import {
  createDocumentCacheMiddleware,
  MemorySegmentCacheStore,
} from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { ResolvedSegment } from "../../types.js";

/** A route handler whose response opts into the document cache. */
const cacheable =
  (render: (ctx: HandlerContext<any>) => React.ReactNode) =>
  (ctx: HandlerContext<any>): React.ReactNode => {
    ctx.headers.set("Cache-Control", "s-maxage=60");
    return render(ctx);
  };

const category = (ctx: HandlerContext<any>): string | undefined =>
  ctx.params.category;

class CountingStore extends MemorySegmentCacheStore {
  writes = 0;
  override putResponse(
    ...args: Parameters<MemorySegmentCacheStore["putResponse"]>
  ) {
    this.writes++;
    return super.putResponse(...args);
  }
}

/**
 * The category layout over a cacheable PLP, and a cacheable item route an
 * intercept targets from the list. `lateOptIn` adds a middleware inside the
 * cache that sets Cache-Control on the response after next(), past the
 * render's own headers.
 */
function app({ lateOptIn = false }: { lateOptIn?: boolean } = {}) {
  const cacheStore = new CountingStore();
  const cached = createRouter({ prefetchCacheTTL: false }).use(
    createDocumentCacheMiddleware(),
  );
  const base = lateOptIn
    ? cached.use(async (_ctx, next) => {
        const response = await next();
        response.headers.set("Cache-Control", "s-maxage=60");
        return response;
      })
    : cached;
  const router = base.routes(
    urls(({ layout, path, revalidate, intercept }) => [
      layout(
        () => <main>chrome</main>,
        () => [
          layout(
            (ctx) => <section>{`hero:${category(ctx)}`}</section>,
            () => [
              revalidate(
                ({ currentParams, nextParams, defaultShouldRevalidate }) =>
                  currentParams.category !== nextParams.category
                    ? true
                    : defaultShouldRevalidate,
              ),
              path(
                "/c/:category",
                cacheable((ctx) => <ul>{`plp:${category(ctx)}`}</ul>),
                { name: "plp" },
              ),
            ],
          ),
          path(
            "/list",
            cacheable(() => <ul>list</ul>),
            { name: "list" },
          ),
          path(
            "/item/:id",
            cacheable((ctx) => <article>{`item:${ctx.params.id}`}</article>),
            { name: "item" },
          ),
          intercept("@modal", "item", () => <dialog>modal</dialog>, {
            when: ({ from }) => from.url.searchParams.get("modal") === "1",
          }),
        ],
      ),
    ]),
  );

  const serve = async (
    url: string,
    partial?: ServeShellRequestOptions["partial"],
  ) => {
    const before = cacheStore.writes;
    const result = await serveShellRequest(router, url, {
      cacheStore,
      partial,
    });
    return {
      result,
      status: result.response.headers.get("x-document-cache-status"),
      writes: cacheStore.writes - before,
    };
  };

  /** The ids a page at `at` holds once a navigation to it committed. */
  const held = async (at: string): Promise<string[]> =>
    (await metadataOf((await serve(at, { from: "/elsewhere" })).result))
      .matched;

  /** A navigation to `to` sent from `from`, which holds `segments`. */
  const navigate = (from: string, segments: string[], to: string) =>
    serve(to, { from, segments });

  return { serve, held, navigate };
}

interface Metadata {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
}

async function metadataOf(result: ServeShellRequestResult): Promise<Metadata> {
  const { metadata } = await deserializeResult<{ metadata: Metadata }>(
    result.flight!,
  );
  return metadata;
}

/** The category layout's id: the layout right above the PLP's route. */
async function heroIdOf(result: ServeShellRequestResult): Promise<string> {
  const { segments } = await metadataOf(result);
  return segments.filter((s) => s.type === "layout").at(-1)!.id;
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("the document cache and a partial that depends on its source page", () => {
  it("a partial a revalidate() kept from the source is not stored, so a page with the same ids gets its own diff", async () => {
    const { serve, held, navigate } = app();
    const audio = await held("/c/audio");
    const tv = await held("/c/tv");
    expect(tv).toEqual(audio);
    const hero = await heroIdOf(
      (await serve("/c/audio", { from: "/x" })).result,
    );

    // From /c/audio the hero is kept: the rule read the source's category.
    const fromAudio = await navigate("/c/audio", audio, "/c/audio?sort=x");
    const audioDiff = await metadataOf(fromAudio.result);
    expect(audioDiff.matched).toContain(hero);
    expect(audioDiff.diff).not.toContain(hero);
    expect(
      fromAudio.result.response.headers.get("x-rsc-prefetch-scope"),
    ).toMatch(/^params; /);

    // From /c/tv, with the same ids, the hero is rendered for audio: served
    // the diff above, the page would keep its tv hero.
    const fromTv = await navigate("/c/tv", tv, "/c/audio?sort=x");
    expect(fromTv.status).not.toBe("HIT");
    expect((await metadataOf(fromTv.result)).diff).toContain(hero);
    expect(fromTv.result.flight).toContain("hero:audio");

    // The kept diff was never stored, and no shared cache may store it.
    expect(fromAudio).toMatchObject({ status: null, writes: 0 });
    expect(fromAudio.result.response.headers.get("cache-control")).toBe(
      "private, no-cache",
    );
  });

  it("a partial whose rule re-rendered the segment is stored and answers any source", async () => {
    const { held, navigate } = app();
    const audio = await held("/c/audio");
    const tv = await held("/c/tv");

    const fromTv = await navigate("/c/tv", tv, "/c/audio?sort=x");
    expect(fromTv).toMatchObject({ status: "MISS", writes: 1 });
    expect(
      fromTv.result.response.headers.get("x-rsc-prefetch-scope"),
    ).toBeNull();

    // Rendering the hero is right from any page: /c/audio gets it too.
    const fromAudio = await navigate("/c/audio", audio, "/c/audio?sort=x");
    expect(fromAudio).toMatchObject({ status: "HIT", writes: 0 });
    expect(fromAudio.result.flight).toContain("hero:audio");
  });

  it("a Cache-Control a middleware sets after the render does not store it", async () => {
    const { held, navigate } = app({ lateOptIn: true });
    const audio = await held("/c/audio");

    const fromAudio = await navigate("/c/audio", audio, "/c/audio?sort=x");
    expect(fromAudio.result.response.headers.get("cache-control")).toBe(
      "s-maxage=60",
    );
    expect(fromAudio).toMatchObject({ status: null, writes: 0 });
  });

  it("a partial of a route an intercept targets is not stored", async () => {
    const { held, navigate } = app();
    const list = await held("/list");

    for (const from of ["/list?modal=1", "/list"]) {
      const result = await navigate(from, list, "/item/1");
      expect(result.result.response.headers.get("x-rsc-prefetch-scope")).toBe(
        "source",
      );
      expect(result).toMatchObject({ status: null, writes: 0 });
    }
  });

  it("a document request is stored and served as before", async () => {
    const { serve } = app();
    expect(await serve("/c/audio?sort=x")).toMatchObject({
      status: "MISS",
      writes: 1,
    });
    expect(await serve("/c/audio?sort=x")).toMatchObject({
      status: "HIT",
      writes: 0,
    });
  });
});
