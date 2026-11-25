/**
 * SPIKE (kept pages, claim B4): what the server reads when a kept clientUrls()
 * page is shown again. The kept page is hidden in the browser, so the
 * request that shows it lists only the page on screen in `_rsc_segments`.
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
import { createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import group from "./fixtures/client-urls-revalidate.js";
import { count, resetRuns } from "./fixtures/client-urls-revalidate-data.js";

const router = createRouter({}).routes(
  urls(({ layout, include }) => [
    layout(
      () => <main>shell</main>,
      () => [include("/shop", group, { name: "shop" })],
    ),
  ]),
);

function matchedOf(result: ServeShellRequestResult): string[] {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  return (JSON.parse(row!.slice(2)).metadata as { matched: string[] }).matched;
}

beforeEach(async () => {
  resetRuns();
  await resetShellTestState();
});

describe("SPIKE B4: a kept group page's loaders on show", () => {
  it("revalidate(false) holds only a loader on screen; the show of a kept page runs it as new", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const serve = (url: string, from: string, segments?: string[]) =>
      serveShellRequest(router, url, {
        cacheStore,
        partial: { from, ...(segments && { segments }) },
      });
    const runs = () => ({
      always: count("always"),
      never: count("never"),
      plain: count("default"),
    });

    // The kept page was drawn once (its first visit).
    const onConstant = matchedOf(await serve("/shop/constant", "/"));
    // Then the person left it for /shop/items/a: the browser holds that page.
    const onItem = matchedOf(
      await serve("/shop/items/a", "/shop/constant", onConstant),
    );
    resetRuns();

    // Show of the kept /shop/constant: the request lists what is on screen.
    await serve("/shop/constant", "/shop/items/a", onItem);
    const onShow = runs();

    // The same navigation as a request that listed the kept page's segments
    // as held (what the browser would have to send for revalidate() to
    // decide the read).
    resetRuns();
    await serve("/shop/constant", "/shop/constant", onConstant);
    const asHeld = runs();

    console.log(
      `[B4a] matched on /shop/constant: ${JSON.stringify(onConstant)}`,
    );
    console.log(`[B4a] matched on /shop/items/a: ${JSON.stringify(onItem)}`);
    console.log(`[B4a] show of kept page, runs: ${JSON.stringify(onShow)}`);
    console.log(`[B4a] same URL with it held, runs: ${JSON.stringify(asHeld)}`);
    expect(onShow).toEqual({ always: 1, never: 1, plain: 1 });
    expect(asHeld).toEqual({ always: 1, never: 0, plain: 0 });
  });
});
