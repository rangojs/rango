/**
 * A stale "use cache" HIT, and a stale cached loader HIT, refresh in the
 * background (SWR) on the visitor's request context. A revalidateTag() in
 * that refresh is not the visitor's mutation: it sets no fresh-reads cookie
 * on the visitor's response, and once the response is sent it warns about
 * nothing. The invalidation itself still runs.
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
} from "../../index.rsc.js";
import {
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

const router = createRouter({
  cacheProfiles: { stale: { ttl: 0, swr: 60 } },
})
  .use(async (_ctx, next) => {
    const response = await next();
    markResponded();
    await returnAfter;
    return response;
  })
  .routes(
    urls(({ path, loader, cache }) => [
      path("/price", PricePage, { name: "price" }),
      path("/rate", RatePage, { name: "rate" }, () => [
        loader(RateLoader, () => [cache({ ttl: 0, swr: 60 })]),
      ]),
    ]),
  );

/** [what refreshes, its route, its body's name, which prefixes its value] */
const CASES = [
  ['"use cache" function', "/price", "getPrice"],
  ["cached loader", "/rate", "RateLoader"],
] as const;

/**
 * A MISS, then a stale HIT whose refresh invalidates; `arm` orders the two
 * between those requests.
 */
async function staleHit(
  url: string,
  body: string,
  arm: () => void,
): Promise<Response> {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const cacheStore = new VercelCacheStore({ cache: vercelCache() });
  expect(cacheStore.freshReadsWindowMs).toBeGreaterThan(0);
  const miss = await serveShellRequest(router, url, { cacheStore });
  expect(miss.body).toContain(`${body}-1`);

  // ttl 0, swr 60: stale from the start, servable for 60 s.
  offset += 1_100;
  arm();
  const stale = await serveShellRequest(router, url, { cacheStore });
  expect(stale.body).toContain(`${body}-1`);
  expect(refresh.runs[body]).toBe(2);
  return stale.response;
}

describe.each(CASES)(
  "a revalidateTag() in a stale %s's refresh",
  (_, url, body) => {
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

    it("sets no fresh-reads cookie on the visitor's response", async () => {
      const invalidateTags = vi.spyOn(
        VercelCacheStore.prototype,
        "invalidateTags",
      );
      const response = await staleHit(url, body, () => {
        returnAfter = new Promise((resolve) => {
          refresh.onInvalidated = resolve;
          // A refresh that never runs fails on `runs`, not a timeout.
          setTimeout(resolve, 1_000);
        });
      });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(invalidateTags).toHaveBeenCalledWith(["prices"]);
    });

    it("does not warn in development once the response is sent", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const warn = vi.spyOn(console, "warn");
      let invalidated = false;
      await staleHit(url, body, () => {
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
