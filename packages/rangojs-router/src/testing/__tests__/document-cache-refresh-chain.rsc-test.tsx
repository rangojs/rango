/**
 * A stale document cache HIT returns the stored response and re-runs the
 * rest of the middleware chain in the background, through its next(), to
 * refresh the entry. That re-run builds its own response: the visitor's
 * request keeps the STALE response for every middleware ahead of the cache,
 * and what middleware after the cache writes reaches the refreshed entry,
 * never the visitor.
 *
 * The middleware ahead of the cache finishes its post-next() work only after
 * the re-run stored the refreshed entry, as an awaited log or metrics call
 * can outlast it.
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
  createRouter,
  urls,
  type HandlerContext,
  type MiddlewareFn,
} from "../../index.rsc.js";
import {
  createDocumentCacheMiddleware,
  MemorySegmentCacheStore,
} from "../../cache/index.js";

const CACHE_CONTROL = "s-maxage=1, stale-while-revalidate=60";

interface Case {
  /** The middleware ahead of the cache returns nothing after next(). */
  forgiving: boolean;
  /** It sets a header after next() and its post-next() work. */
  upstreamPost: boolean;
  /** The middleware after the cache sets a header after an await, before next(). */
  downstreamPre: boolean;
}

let current: Case;
let renders = 0;
let downstreamRuns = 0;
/** Settles once the re-run stored the refreshed entry. */
let rerunStored: Promise<void> | undefined;

function DocPage(ctx: HandlerContext): React.ReactNode {
  ctx.headers.set("Cache-Control", CACHE_CONTROL);
  return <p>{`DocPage-${++renders}`}</p>;
}

const ahead: MiddlewareFn = async (ctx, next) => {
  const response = await next();
  await rerunStored;
  if (current.upstreamPost) ctx.header("x-upstream-post", "1");
  if (current.forgiving) return;
  return response;
};

const after: MiddlewareFn = async (ctx, next) => {
  const run = ++downstreamRuns;
  if (current.downstreamPre) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctx.header("x-downstream-pre", String(run));
  }
  return next();
};

const router = createRouter()
  .use(ahead)
  .use(createDocumentCacheMiddleware())
  .use(after)
  .routes(urls(({ path }) => [path("/doc", DocPage, { name: "doc" })]));

const status = (response: Response): string | null =>
  response.headers.get("x-document-cache-status");

/**
 * A MISS, then a stale HIT whose middleware ahead of the cache returns after
 * the re-run stored, then the next request, which reads what it stored.
 */
async function staleHitThenNext(options: Partial<Case>): Promise<{
  stale: Response;
  staleBody: string;
  next: Response;
  nextBody: string;
}> {
  current = {
    forgiving: false,
    upstreamPost: false,
    downstreamPre: false,
    ...options,
  };
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const cacheStore = new MemorySegmentCacheStore();
  const putResponse = cacheStore.putResponse.bind(cacheStore);
  let markStored = (): void => {};
  cacheStore.putResponse = async (...args) => {
    await putResponse(...args);
    markStored();
  };
  const miss = await serveShellRequest(router, "/doc", { cacheStore });
  expect(status(miss.response)).toBe("MISS");
  expect(miss.body).toContain("DocPage-1");

  // Past the s-maxage=1, within the 60 s swr.
  offset += 2_100;
  rerunStored = new Promise((resolve) => {
    markStored = resolve;
    // A re-run that never stores fails on `renders`, not a timeout.
    setTimeout(resolve, 1_000);
  });
  const stale = await serveShellRequest(router, "/doc", { cacheStore });
  expect(renders).toBe(2);

  rerunStored = undefined;
  const next = await serveShellRequest(router, "/doc", { cacheStore });
  return {
    stale: stale.response,
    staleBody: stale.body,
    next: next.response,
    nextBody: next.body,
  };
}

beforeEach(async () => {
  await resetShellTestState();
  renders = 0;
  downstreamRuns = 0;
  rerunStored = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a stale document cache entry's background re-run of the middleware chain", () => {
  it("leaves the STALE response to a middleware ahead of the cache that returns nothing after next()", async () => {
    const { stale, staleBody, next, nextBody } = await staleHitThenNext({
      forgiving: true,
    });
    expect({ visitor: status(stale), next: status(next) }).toEqual({
      visitor: "STALE",
      next: "HIT",
    });
    expect(staleBody).toContain("DocPage-1");
    expect(nextBody).toContain("DocPage-2");
  });

  it("puts a header that a middleware ahead of the cache sets after next() on the STALE response", async () => {
    const { stale } = await staleHitThenNext({ upstreamPost: true });
    expect({
      status: status(stale),
      header: stale.headers.get("x-upstream-post"),
    }).toEqual({ status: "STALE", header: "1" });
  });

  it("puts a header that a middleware after the cache sets before next() on the refreshed entry, not the STALE response", async () => {
    const { stale, next, nextBody } = await staleHitThenNext({
      downstreamPre: true,
    });
    // The STALE response is the MISS's entry, with the MISS run's header.
    expect({
      visitor: stale.headers.get("x-downstream-pre"),
      next: status(next),
      stored: next.headers.get("x-downstream-pre"),
    }).toEqual({ visitor: "1", next: "HIT", stored: "2" });
    expect(nextBody).toContain("DocPage-2");
  });

  it("keeps its handler timing off the STALE response's Server-Timing", async () => {
    const { stale } = await staleHitThenNext({});
    const timing = stale.headers.get("Server-Timing") ?? "";
    // A stale HIT never classifies: only the re-run does.
    expect({
      status: status(stale),
      bootstrap: timing.includes("handler-nonce"),
      classify: timing.includes("handler-classify"),
    }).toEqual({ status: "STALE", bootstrap: true, classify: false });
  });
});
