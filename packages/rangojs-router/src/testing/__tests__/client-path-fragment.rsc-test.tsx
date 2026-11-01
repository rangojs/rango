/**
 * The page on screen can carry a `#fragment`; the browser sends its whole
 * address as `X-RSC-Router-Client-Path`, but never a fragment in the request
 * URL. `revalidate()` must see the two as comparable addresses: `currentUrl`
 * has no fragment, so "same address" rules (`currentUrl.href === nextUrl.href`)
 * agree with what the user sees. Through the public testing primitives
 * (serveShellRequest).
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import {
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
  type RevalidateParams,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

let loaderRuns = 0;
let seen: RevalidateParams | undefined;

const TicketLoader = createLoader(async (ctx) => {
  loaderRuns++;
  return { ticket: String(ctx.params.id) };
});

/** "Same address: decide as usual (a stale segment is read again); else hold." */
function sameAddressDefers(args: RevalidateParams): boolean | undefined {
  seen = args;
  return args.currentUrl.href === args.nextUrl.href ? undefined : false;
}

const router = createRouter().routes(
  urls(({ path, loader, revalidate }) => [
    path("/", () => <main>home</main>, { name: "home" }),
    path(
      "/t/:id",
      (ctx: HandlerContext<{ id: string }>) => (
        <main>{`ticket ${ctx.params.id}`}</main>
      ),
      { name: "ticket" },
      () => [loader(TicketLoader, () => [revalidate(sameAddressDefers)])],
    ),
  ]),
);

type Metadata = { matched: string[]; diff: string[] };

function metadata(result: { flight?: string }): Metadata {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  return (JSON.parse(row!.slice(2)) as { metadata: Metadata }).metadata;
}

beforeEach(async () => {
  await resetShellTestState();
  loaderRuns = 0;
  seen = undefined;
});

describe("a revalidate() rule on a page whose address has a #fragment", () => {
  it("sees currentUrl without the fragment, equal to nextUrl", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, "/t/42", {
      cacheStore,
      partial: { from: "/" },
    });
    await serveShellRequest(router, "/t/42", {
      cacheStore,
      partial: {
        from: "/t/42#questions",
        segments: metadata(page).matched,
      },
    });
    expect(seen).toBeDefined();
    expect(seen!.currentUrl.hash).toBe("");
    expect(seen!.currentUrl.href).toBe(seen!.nextUrl.href);
  });

  it("reads a stale segment again: the same-address check lets the stale default apply", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, "/t/42", {
      cacheStore,
      partial: { from: "/" },
    });
    loaderRuns = 0;
    await serveShellRequest(router, "/t/42", {
      cacheStore,
      partial: {
        from: "/t/42#questions",
        segments: metadata(page).matched,
        stale: true,
      },
    });
    expect(loaderRuns).toBe(1);
  });

  it("matches the page by its path and keeps the query", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, "/t/42?tab=a", {
      cacheStore,
      partial: { from: "/" },
    });
    await serveShellRequest(router, "/t/42?tab=a", {
      cacheStore,
      partial: {
        from: "/t/42?tab=a#questions",
        segments: metadata(page).matched,
      },
    });
    expect(seen!.currentParams).toEqual({ id: "42" });
    expect(seen!.currentUrl.search).toBe("?tab=a");
    expect(seen!.currentUrl.hash).toBe("");
    expect(seen!.fromRouteName).toBe("ticket");
  });
});
