/**
 * The document cache never answers a stale request (`_rsc_stale`). Served
 * through the public serveShellRequest with `partial.stale`: it renders fresh, so the layout's `stale`-reading loader re-runs, and the entry stored
 * for the same request without the flag is neither served to it nor replaced
 * by it.
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
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  createDocumentCacheMiddleware,
  MemorySegmentCacheStore,
} from "../../cache/index.js";

const runs = { page: 0, cart: 0 };

/** The layout's cart count: it follows mutations through `stale`. */
const CartLoader = createLoader(async () => {
  return ++runs.cart;
});

function CachedPage(ctx: HandlerContext): React.ReactNode {
  ctx.headers.set("Cache-Control", "s-maxage=60");
  return <p>{`page-run-${++runs.page}`}</p>;
}

const status = (result: ServeShellRequestResult): string | null =>
  result.response.headers.get("x-document-cache-status");

/** The ids a partial response says the page holds (`metadata.matched`). */
function matchedOf(result: ServeShellRequestResult): string[] {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  return JSON.parse(row!.slice(2)).metadata.matched;
}

async function setup() {
  const cacheStore = new MemorySegmentCacheStore();
  const router = createRouter()
    .use(createDocumentCacheMiddleware())
    .routes(
      urls(({ path, layout, loader, revalidate }) => [
        layout(
          () => <p>layout</p>,
          () => [
            loader(CartLoader, () => [
              revalidate(
                ({ stale, defaultShouldRevalidate }) =>
                  stale || defaultShouldRevalidate,
              ),
            ]),
            path("/a", CachedPage, { name: "a" }),
            path("/b", CachedPage, { name: "b" }),
          ],
        ),
      ]),
    );
  // The page /a, as a client on it holds it.
  const held = matchedOf(
    await serveShellRequest(router, "/a", {
      cacheStore,
      partial: { from: "/" },
    }),
  );
  /** A navigation from /a to /b. */
  const toB = (stale?: boolean) =>
    serveShellRequest(router, "/b", {
      cacheStore,
      partial: { from: "/a", segments: held, stale },
    });
  return { toB };
}

describe("the document cache and a stale request", () => {
  beforeEach(async () => {
    await resetShellTestState();
    runs.page = 0;
    runs.cart = 0;
  });

  it("a stale navigation renders fresh and leaves the stored entry as it was", async () => {
    const { toB } = await setup();
    const stored = await toB();
    expect(status(stored)).toBe("MISS");
    expect(status(await toB())).toBe("HIT");
    // The held layout's loader ran once, for /a.
    expect(runs).toEqual({ page: 2, cart: 1 });

    const stale = await toB(true);
    expect(status(stale)).toBeNull();
    expect(runs).toEqual({ page: 3, cart: 2 });

    const again = await toB();
    expect(status(again)).toBe("HIT");
    expect(again.body).toBe(stored.body);
    expect(runs).toEqual({ page: 3, cart: 2 });
  });

  it("serveShellRequest rejects a stale prefetch, which the browser never sends", async () => {
    const router = createRouter().routes(
      urls(({ path }) => [path("/x", () => <p>x</p>, { name: "x" })]),
    );
    await expect(
      serveShellRequest(router, "/x", {
        partial: { stale: true, prefetch: true },
      }),
    ).rejects.toThrow("partial.stale cannot be combined with partial.prefetch");
  });
});
