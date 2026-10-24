/**
 * A stale "use cache" HIT, a stale cached loader HIT and a stale document
 * cache HIT refresh in the background (SWR) on the visitor's request context.
 * A revalidateTag() in that refresh is not the visitor's mutation: it sets no
 * fresh-reads cookie on the visitor's response, and once the response is sent
 * it warns about nothing. The invalidation itself still runs.
 *
 * The global middleware's post-next() work can outlast the refresh, as an
 * awaited log or metrics call can; the response it returns merges the
 * request's cookies (router/middleware.ts mergeResponse).
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
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
  type MiddlewareFn,
} from "../../index.rsc.js";
import {
  createDocumentCacheMiddleware,
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";
import {
  getPrice,
  refresh,
  runAndInvalidateOnRefresh,
} from "./fixtures/use-cache-refresh-fresh-reads-data.js";

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

let markResponded = (): void => {};
/** The middleware returns the stale HIT's response once this settles. */
let returnAfter: Promise<void> | undefined;

const RateLoader = createLoader(
  async () => `RateLoader-${await runAndInvalidateOnRefresh("RateLoader")}`,
);

async function PricePage(): Promise<React.ReactNode> {
  return <p>{await getPrice()}</p>;
}

async function RatePage(ctx: HandlerContext): Promise<React.ReactNode> {
  return <p>{await ctx.use(RateLoader)}</p>;
}

/** The document cache re-runs the whole page in its refresh. */
async function DocPage(ctx: HandlerContext): Promise<React.ReactNode> {
  ctx.headers.set("Cache-Control", "s-maxage=1, stale-while-revalidate=60");
  return <p>{`DocPage-${await runAndInvalidateOnRefresh("DocPage")}`}</p>;
}

const respondAfterReturnGate: MiddlewareFn = async (_ctx, next) => {
  const response = await next();
  markResponded();
  await returnAfter;
  return response;
};

const router = createRouter({
  cacheProfiles: { stale: { ttl: 0, swr: 60 } },
})
  .use(respondAfterReturnGate)
  .routes(
    urls(({ path, loader, cache }) => [
      path("/price", PricePage, { name: "price" }),
      path("/rate", RatePage, { name: "rate" }, () => [
        loader(RateLoader, () => [cache({ ttl: 0, swr: 60 })]),
      ]),
    ]),
  );

const docRouter = createRouter()
  .use(respondAfterReturnGate)
  .use(createDocumentCacheMiddleware())
  .routes(urls(({ path }) => [path("/doc", DocPage, { name: "doc" })]));

/**
 * [what refreshes, its router, its route, its body's name, which prefixes
 * its value]
 */
const CASES = [
  ['"use cache" function', router, "/price", "getPrice"],
  ["cached loader", router, "/rate", "RateLoader"],
  ["document cache entry", docRouter, "/doc", "DocPage"],
] as const;

/**
 * A MISS, then a stale HIT whose refresh invalidates; `arm` orders the two
 * between those requests.
 */
async function staleHit(
  app: typeof router | typeof docRouter,
  url: string,
  body: string,
  arm: () => void,
): Promise<{ response: Response; cacheStore: VercelCacheStore }> {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const cacheStore = new VercelCacheStore({ cache: vercelCache() });
  expect(cacheStore.freshReadsWindowMs).toBeGreaterThan(0);
  const miss = await serveShellRequest(app, url, { cacheStore });
  expect(miss.body).toContain(`${body}-1`);

  // Past every entry's freshness (ttl 0, or the page's s-maxage=1) and
  // within its 60 s swr.
  offset += 2_100;
  arm();
  const stale = await serveShellRequest(app, url, { cacheStore });
  expect(stale.body).toContain(`${body}-1`);
  expect(refresh.runs[body]).toBe(2);
  return { response: stale.response, cacheStore };
}

/** The refresh invalidates before the visitor's response is returned. */
function invalidateBeforeResponse(): void {
  returnAfter = new Promise((resolve) => {
    refresh.onInvalidated = resolve;
    // A refresh that never runs fails on `runs`, not a timeout.
    setTimeout(resolve, 1_000);
  });
}

beforeEach(async () => {
  await resetShellTestState();
  refresh.runs = {};
  refresh.invalidateAfter = undefined;
  refresh.onInvalidated = () => {};
  markResponded = () => {};
  returnAfter = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(CASES)(
  "a revalidateTag() in a stale %s's refresh",
  (_, app, url, body) => {
    it("sets no fresh-reads cookie on the visitor's response", async () => {
      const invalidateTags = vi.spyOn(
        VercelCacheStore.prototype,
        "invalidateTags",
      );
      const { response } = await staleHit(
        app,
        url,
        body,
        invalidateBeforeResponse,
      );
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(invalidateTags).toHaveBeenCalledWith(["prices"]);
    });

    it("does not warn in development once the response is sent", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const warn = vi.spyOn(console, "warn");
      let invalidated = false;
      await staleHit(app, url, body, () => {
        refresh.onInvalidated = () => {
          invalidated = true;
        };
        refresh.invalidateAfter = new Promise((resolve) => {
          markResponded = resolve;
        });
      });
      expect(invalidated).toBe(true);
      expect(warn.mock.calls.flat().join("\n")).not.toContain(
        "after the response headers were sent",
      );
    });
  },
);

describe("a stale document cache entry whose refresh invalidates", () => {
  // A cookie on the re-run's own response would keep it out: the document
  // cache stores no response with a Set-Cookie.
  it("stores the refreshed page for the next visitor", async () => {
    const { cacheStore } = await staleHit(
      docRouter,
      "/doc",
      "DocPage",
      invalidateBeforeResponse,
    );
    const next = await serveShellRequest(docRouter, "/doc", { cacheStore });
    expect(next.body).toContain("DocPage-2");
  });
});
