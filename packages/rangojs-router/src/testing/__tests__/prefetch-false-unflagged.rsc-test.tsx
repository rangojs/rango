/**
 * R9 of docs/design/prefetch-false.md: a prefetch response for a route that
 * declares no `prefetch: false` is byte-identical to what it was before the
 * option existed. The snapshot below was recorded on main 844ccda5, before
 * any of the feature was built; the test fails if a prefetch of an unflagged
 * route ever carries a deferred marker, a new header or a changed `vary`.
 */
import { fileURLToPath } from "node:url";
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createLoader, createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const PriceLoader = createLoader(async () => ({ price: 12 }));
const StockLoader = createLoader(async () => ({ stock: 3 }));

const router = createRouter({ id: "unflagged", version: "v1" }).routes(
  urls(({ path, layout, loader, loading, parallel }) => [
    layout(
      () => <main>shell</main>,
      () => [
        loader(StockLoader),
        path("/", () => <ul>home</ul>, { name: "home" }),
        path(
          "/product/:id",
          (ctx) => <article>{`product-${ctx.params.id}`}</article>,
          { name: "product" },
          () => [
            loader(PriceLoader),
            loading(<p>product-loading</p>),
            parallel({ "@side": () => <aside>side</aside> }, () => [
              loading(<p>side-loading</p>),
            ]),
          ],
        ),
      ],
    ),
  ]),
);

/** Client references carry the module's absolute path: the checkout's. */
const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

async function partial(prefetch: boolean) {
  const { response, flight } = await serveShellRequest(router, "/product/1", {
    cacheStore: new MemorySegmentCacheStore(),
    partial: { from: "/", prefetch },
  });
  const headers: string[] = [];
  response.headers.forEach((_value, name) => headers.push(name));
  return {
    flight: flight?.replaceAll(PACKAGE_ROOT, "<package>/"),
    vary: response.headers.get("vary"),
    cacheControl: response.headers.get("cache-control"),
    headers: headers.sort(),
  };
}

beforeEach(() => resetShellTestState());

describe("a prefetch of a route with no prefetch: false", () => {
  it("is byte-identical to the response before the option existed", async () => {
    const result = await partial(true);
    expect(result.flight).not.toContain("deferred");
    expect(result).toMatchSnapshot();
  });

  it("differs from a navigation of the same route only by its cache-control", async () => {
    const prefetched = await partial(true);
    const navigated = await partial(false);
    expect(prefetched.flight).toBe(navigated.flight);
    expect(prefetched.vary).toBe(navigated.vary);
    expect(navigated.cacheControl).toBeNull();
    expect(prefetched.cacheControl).toMatch(/^private, max-age=/);
  });
});
