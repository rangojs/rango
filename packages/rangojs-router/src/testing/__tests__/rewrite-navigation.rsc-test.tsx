/**
 * Requests from a page middleware reached through `throw rewrite()` (#1144,
 * #1145), through the public testing primitives (serveShellRequest).
 *
 * The payload of a rewritten request carries `metadata.rewriteTarget`, the
 * target's path and search. The browser sends it back from that page as
 * `_rsc_rt` (serveShellRequest's `rewriteTarget`), and the
 * server diffs against the route that rendered the page, not the route the
 * visitor's URL matches: a navigation within the page holds what a direct
 * visit holds, and `revalidate()` sees the target's params and URL.
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
  rewrite,
  urls,
  type HandlerContext,
  type RevalidateParams,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

let loaderRuns = 0;
let actionRuns = 0;
let guardRuns = 0;
let seen: RevalidateParams | undefined;

const ItemLoader = createLoader(async (ctx) => {
  loaderRuns++;
  return { item: String(ctx.params.id) };
});

async function save(): Promise<string> {
  actionRuns++;
  return "saved";
}

/** Re-run only when the item changes: a sort change holds the loader. */
function itemScoped(args: RevalidateParams): boolean {
  seen = args;
  return args.currentParams.id !== args.nextParams.id;
}

function makeRouter(options: { predicate?: boolean } = {}) {
  return createRouter().routes(
    urls(({ path, middleware, loader, revalidate }) => [
      path("/", () => <main>home</main>, { name: "home" }),
      path(
        "/item/:id",
        (ctx: HandlerContext<{ id: string }>) => (
          <main>{`item ${ctx.params.id}`}</main>
        ),
        { name: "item" },
        () => [
          options.predicate
            ? loader(ItemLoader, () => [revalidate(itemScoped)])
            : loader(ItemLoader),
        ],
      ),
      path(
        "/admin",
        () => <main>admin</main>,
        { name: "admin" },
        () => [
          middleware(() => {
            guardRuns++;
            return new Response("Forbidden", { status: 403 });
          }),
        ],
      ),
      // One target for several visitor URLs, rendering the visitor's.
      path(
        "/landing",
        (ctx: HandlerContext) => (
          <main>{`landing for ${ctx.rewrittenFrom?.pathname}`}</main>
        ),
        { name: "landing" },
      ),
      path(
        "/*",
        () => <main>fallback</main>,
        { name: "fallback" },
        () => [
          middleware((ctx, next) => {
            if (ctx.pathname.startsWith("/promo-")) throw rewrite("/landing");
            if (ctx.pathname.startsWith("/public-")) {
              throw rewrite(`/item/${ctx.pathname.slice(8)}${ctx.url.search}`);
            }
            return next();
          }),
        ],
      ),
    ]),
  );
}

type Metadata = {
  matched: string[];
  diff: string[];
  routeName?: string;
  rewriteTarget?: string;
};

function metadata(result: { flight?: string }): Metadata {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  return (JSON.parse(row!.slice(2)) as { metadata: Metadata }).metadata;
}

beforeEach(async () => {
  await resetShellTestState();
  loaderRuns = 0;
  actionRuns = 0;
  guardRuns = 0;
  seen = undefined;
});

describe("a rewritten page's payload", () => {
  it("carries the target's path and search as rewriteTarget", async () => {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, "/public-1?sort=a", {
      cacheStore,
      partial: { from: "/" },
    });
    expect(metadata(page).rewriteTarget).toBe("/item/1?sort=a");

    const doc = await serveShellRequest(router, "/public-1?sort=a", {
      cacheStore,
    });
    expect(metadata(doc).rewriteTarget).toBe("/item/1?sort=a");
  });

  it("carries none for a page nothing rewrote", async () => {
    const router = makeRouter();
    const page = await serveShellRequest(router, "/item/1?sort=a", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/" },
    });
    expect(metadata(page)).not.toHaveProperty("rewriteTarget");
  });
});

describe.each(["/item/1", "/public-1"])("a page at %s", (url) => {
  it("a navigation to the page already shown re-renders nothing", async () => {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, `${url}?sort=a`, {
      cacheStore,
      partial: { from: "/" },
    });
    loaderRuns = 0;
    const again = await serveShellRequest(router, `${url}?sort=a`, {
      cacheStore,
      partial: {
        from: `${url}?sort=a`,
        rewriteTarget: metadata(page).rewriteTarget,
        segments: metadata(page).matched,
      },
    });
    expect(metadata(again).diff).toEqual([]);
    expect(loaderRuns).toBe(0);
  });

  it("a sort change holds a loader whose revalidate() compares the route param", async () => {
    const router = makeRouter({ predicate: true });
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, `${url}?sort=a`, {
      cacheStore,
      partial: { from: "/" },
    });
    loaderRuns = 0;
    await serveShellRequest(router, `${url}?sort=b`, {
      cacheStore,
      partial: {
        from: `${url}?sort=a`,
        rewriteTarget: metadata(page).rewriteTarget,
        segments: metadata(page).matched,
      },
    });
    expect(seen?.currentParams).toEqual({ id: "1" });
    expect(loaderRuns).toBe(0);
    // Both URLs in the target's frame, and the route it leaves by name.
    expect(seen?.currentUrl.pathname).toBe("/item/1");
    expect(seen?.nextUrl.pathname).toBe("/item/1");
    expect(seen?.fromRouteName).toBe("item");
  });

  it("a JS action re-renders against the page it shows", async () => {
    const router = makeRouter({ predicate: true });
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, `${url}?sort=a`, {
      cacheStore,
      partial: { from: "/" },
    });
    const result = await serveShellRequest(router, `${url}?sort=a`, {
      cacheStore,
      action: {
        ref: save,
        id: "actions.ts#save",
        segments: metadata(page).matched,
        rewriteTarget: metadata(page).rewriteTarget,
      },
    });
    expect(actionRuns).toBe(1);
    expect(metadata(result).routeName).toBe("item");
    expect(seen?.currentParams).toEqual({ id: "1" });
    expect(seen?.fromRouteName).toBe("item");
  });
});

describe("visitor URLs that rewrite to one target", () => {
  async function navigate(from: string, to: string): Promise<Metadata> {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, from, {
      cacheStore,
      partial: { from: "/" },
    });
    expect(metadata(page).rewriteTarget).toBe("/landing");
    return metadata(
      await serveShellRequest(router, to, {
        cacheStore,
        partial: {
          from,
          rewriteTarget: metadata(page).rewriteTarget,
          segments: metadata(page).matched,
        },
      }),
    );
  }

  it("a move of the visitor's URL re-renders the route, which may read ctx.rewrittenFrom", async () => {
    const next = await navigate("/promo-a", "/promo-b");
    expect(next.diff).toContain(next.matched[next.matched.length - 1]);
  });

  it("the same visitor URL re-renders nothing", async () => {
    expect((await navigate("/promo-a", "/promo-a")).diff).toEqual([]);
  });
});

describe("_rsc_rt", () => {
  it("never chooses what renders: a forged value skips no middleware", async () => {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const result = await serveShellRequest(router, "/admin", {
      cacheStore,
      partial: { from: "/admin", rewriteTarget: "/admin", segments: [] },
    });
    expect(result.response.status).toBe(403);
    expect(guardRuns).toBe(1);

    const page = await serveShellRequest(router, "/public-2", {
      cacheStore,
      partial: { from: "/public-1", rewriteTarget: "/admin", segments: [] },
    });
    expect(page.response.status).toBe(200);
    expect(metadata(page).routeName).toBe("item");
    expect(guardRuns).toBe(1);
  });

  it("is ignored when it names another origin", async () => {
    const router = makeRouter({ predicate: true });
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, "/public-1?sort=a", {
      cacheStore,
      partial: { from: "/" },
    });
    await serveShellRequest(router, "/public-1?sort=b", {
      cacheStore,
      partial: {
        from: "/public-1?sort=a",
        rewriteTarget: "https://elsewhere.example/item/1?sort=a",
        segments: metadata(page).matched,
      },
    });
    expect(seen?.currentParams).toEqual({ "*": "public-1" });
  });
});
