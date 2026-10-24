/**
 * A stale cache() HIT re-renders the route in the background (SWR). A
 * revalidateTag() in that render is not the visitor's mutation: it sets no
 * fresh-reads cookie on the visitor's response, and once the response is
 * sent it warns about nothing.
 *
 * The global middleware's post-next() work can outlast the background render,
 * as an awaited log or metrics call can; the response it returns merges the
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
import { createRouter, revalidateTag, urls } from "../../index.rsc.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";

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

let renders = 0;
let markResponded = (): void => {};
let markRerendered = (): void => {};
/** The background run invalidates once this settles. */
let invalidateAfter: Promise<void> | undefined;
/** The middleware returns the stale HIT's response once this settles. */
let returnAfter: Promise<void> | undefined;

/** Its second run, the background one, invalidates a tag. */
async function Page(): Promise<React.ReactNode> {
  renders += 1;
  if (renders > 1) {
    if (invalidateAfter) {
      await invalidateAfter;
      // rsc/handler.ts marks the response sent in the microtasks after it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    revalidateTag("prices");
    markRerendered();
  }
  return <p>{`page-${renders}`}</p>;
}

const router = createRouter({})
  .use(async (_ctx, next) => {
    const response = await next();
    markResponded();
    await returnAfter;
    return response;
  })
  .routes(
    urls(({ path, cache }) => [
      cache({ ttl: 0, swr: 60 }, () => [path("/swr", Page, { name: "swr" })]),
    ]),
  );

/**
 * A MISS, then a stale HIT whose background re-render invalidates; `arm`
 * orders the two between those requests.
 */
async function staleHit(arm: () => void): Promise<Response> {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const cacheStore = new VercelCacheStore({ cache: vercelCache() });
  expect(cacheStore.freshReadsWindowMs).toBeGreaterThan(0);
  const miss = await serveShellRequest(router, "/swr", { cacheStore });
  expect(miss.body).toContain("page-1");

  // cache({ ttl: 0, swr: 60 }): stale from the start, servable for 60 s.
  offset += 1_100;
  arm();
  const stale = await serveShellRequest(router, "/swr", { cacheStore });
  expect(stale.body).toContain("page-1");
  expect(renders).toBe(2);
  return stale.response;
}

describe("a revalidateTag() in a stale cache() HIT's background re-render", () => {
  beforeEach(async () => {
    await resetShellTestState();
    renders = 0;
    markResponded = () => {};
    markRerendered = () => {};
    invalidateAfter = undefined;
    returnAfter = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sets no fresh-reads cookie on the visitor's response", async () => {
    const response = await staleHit(() => {
      returnAfter = new Promise((resolve) => {
        markRerendered = resolve;
        // A refresh that never runs fails on `renders`, not a timeout.
        setTimeout(resolve, 1_000);
      });
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("does not warn in development once the response is sent", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn");
    await staleHit(() => {
      invalidateAfter = new Promise((resolve) => {
        markResponded = resolve;
      });
    });
    expect(warn.mock.calls.flat().join("\n")).not.toContain(
      "after the response headers were sent",
    );
  });
});
