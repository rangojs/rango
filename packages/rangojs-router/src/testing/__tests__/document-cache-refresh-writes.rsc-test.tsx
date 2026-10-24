/**
 * A stale document cache HIT re-runs the page in the background (SWR) to
 * refresh the stored entry. The re-run's response writes (a cookie, a
 * header) belong to the re-run's own response: none reaches the visitor
 * served the stale entry, and the refreshed entry is stored by the document
 * cache's usual policy (headers kept, a response that sets a cookie
 * refused). The re-run starts from what the middleware ahead of the cache
 * wrote before next(), as a MISS does; what it writes after next() is the
 * visitor's only.
 *
 * The global middleware's post-next() work outlasts the re-run's writes, as
 * an awaited log or metrics call can; the response it returns merges the
 * request's cookies and headers (router/middleware.ts mergeResponse).
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
  cookies,
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
  /** The page's re-run sets a cookie besides its header. */
  rerunCookie: boolean;
  /** The middleware ahead of the cache sets a cookie after next(). */
  visitorCookie: boolean;
  /** That middleware, not the page, opts in before next(). */
  middlewareOptsIn: boolean;
}

let current: Case;
let runs = 0;
let markRerunWrote = (): void => {};
/** The middleware returns the stale HIT's response once this settles. */
let returnAfter: Promise<void> | undefined;

function DocPage(ctx: HandlerContext): React.ReactNode {
  if (!current.middlewareOptsIn)
    ctx.headers.set("Cache-Control", CACHE_CONTROL);
  const run = ++runs;
  if (run > 1) {
    ctx.headers.set("x-rerun", String(run));
    if (current.rerunCookie) cookies().set("rerun-cookie", String(run));
    markRerunWrote();
  }
  return <p>{`DocPage-${run}`}</p>;
}

const respondAfterGate: MiddlewareFn = async (ctx, next) => {
  if (current.middlewareOptsIn) ctx.header("Cache-Control", CACHE_CONTROL);
  const response = await next();
  if (current.visitorCookie) cookies().set("visitor-cookie", "1");
  await returnAfter;
  return response;
};

const router = createRouter()
  .use(respondAfterGate)
  .use(createDocumentCacheMiddleware())
  .routes(urls(({ path }) => [path("/doc", DocPage, { name: "doc" })]));

const status = (response: Response): string | null =>
  response.headers.get("x-document-cache-status");

/**
 * A MISS, then a stale HIT whose re-run writes before the HIT returns, then
 * the next visitor's request, which reads what the re-run stored.
 */
async function staleHitThenNext(
  options: Partial<Case>,
): Promise<{ stale: Response; next: Response; nextBody: string }> {
  current = {
    rerunCookie: false,
    visitorCookie: false,
    middlewareOptsIn: false,
    ...options,
  };
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const cacheStore = new MemorySegmentCacheStore();
  const miss = await serveShellRequest(router, "/doc", { cacheStore });
  expect(status(miss.response)).toBe("MISS");
  expect(miss.body).toContain("DocPage-1");

  // Past the s-maxage=1, within the 60 s swr.
  offset += 2_100;
  returnAfter = new Promise((resolve) => {
    markRerunWrote = resolve;
    // A re-run that never runs fails on `runs`, not a timeout.
    setTimeout(resolve, 1_000);
  });
  const stale = await serveShellRequest(router, "/doc", { cacheStore });
  expect(status(stale.response)).toBe("STALE");
  expect(stale.body).toContain("DocPage-1");
  expect(runs).toBe(2);

  returnAfter = undefined;
  current = { ...current, visitorCookie: false };
  const next = await serveShellRequest(router, "/doc", { cacheStore });
  return { stale: stale.response, next: next.response, nextBody: next.body };
}

/** The headers a test reads, one object so a failure shows them all. */
const writes = (response: Response) => ({
  cookies: response.headers.getSetCookie(),
  rerun: response.headers.get("x-rerun"),
});

beforeEach(async () => {
  await resetShellTestState();
  runs = 0;
  markRerunWrote = () => {};
  returnAfter = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a stale document cache entry's background re-run", () => {
  it("sets none of its cookies or headers on the visitor's response", async () => {
    const { stale } = await staleHitThenNext({ rerunCookie: true });
    expect(writes(stale)).toEqual({ cookies: [], rerun: null });
  });

  it("stores the refreshed page with the headers it set", async () => {
    const { next, nextBody } = await staleHitThenNext({});
    expect(status(next)).toBe("HIT");
    expect(nextBody).toContain("DocPage-2");
    expect(writes(next)).toEqual({ cookies: [], rerun: "2" });
    expect(runs).toBe(2);
  });

  it("stores nothing when it sets a cookie", async () => {
    const { next, nextBody } = await staleHitThenNext({ rerunCookie: true });
    expect(status(next)).toBe("STALE");
    expect(nextBody).toContain("DocPage-1");
  });

  it("starts from what the middleware ahead of the cache wrote before next()", async () => {
    const { next, nextBody } = await staleHitThenNext({
      middlewareOptsIn: true,
    });
    expect(status(next)).toBe("HIT");
    expect(nextBody).toContain("DocPage-2");
  });

  it("leaves the visitor's own cookie on the visitor's response, not on the refreshed page", async () => {
    const { stale, next, nextBody } = await staleHitThenNext({
      visitorCookie: true,
    });
    expect({
      visitor: writes(stale),
      next: status(next),
      stored: writes(next),
    }).toEqual({
      visitor: { cookies: ["visitor-cookie=1"], rerun: null },
      next: "HIT",
      stored: { cookies: [], rerun: "2" },
    });
    expect(nextBody).toContain("DocPage-2");
  });
});
