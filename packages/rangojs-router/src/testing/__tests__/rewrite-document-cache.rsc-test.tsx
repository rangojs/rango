/**
 * The document cache under a request middleware rewrote, through the
 * production request handler (serveShellRequest). A URL's stored document is
 * read and written only by requests on that URL, as a PPR shell is, and
 * `rewrite(...).shell("visitor" | "target")` picks an entry for the rewritten
 * request: its own, keyed by the visitor's URL and the target, or the
 * target's.
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

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createRouter,
  rewrite,
  urls,
  type HandlerContext,
  type OnErrorContext,
  type RewriteShell,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
  type DocumentCacheOptions,
} from "../../cache/index.js";

/** `/<audience>-<id>` rewrites to `/item/<id>` (or `/item/<x-arm>`), keeping the search. */
const AUDIENCES: Record<string, RewriteShell | undefined> = {
  public: undefined,
  visitor: "visitor",
  other: "visitor",
  target: "target",
};

let renders = 0;
const errors: OnErrorContext[] = [];

function buildRouter(options?: DocumentCacheOptions) {
  return createRouter({ onError: (context) => void errors.push(context) })
    .use(createDocumentCacheMiddleware(options))
    .routes(
      urls(({ path, middleware }) => [
        path(
          "/item/:id",
          (ctx: HandlerContext<{ id: string }>) => (
            <main>
              {`item ${ctx.params.id} from=${ctx.rewrittenFrom?.pathname ?? "-"} render=${++renders}`}
            </main>
          ),
          { name: "item" },
          () => [
            middleware(async (ctx, next) => {
              const late = ctx.request.headers.get("x-late") === "1";
              const control =
                ctx.request.headers.get("x-swr") === "1"
                  ? "s-maxage=1, stale-while-revalidate=60"
                  : "s-maxage=60";
              if (!late) ctx.header("Cache-Control", control);
              await next();
              if (late) ctx.header("Cache-Control", control);
            }),
          ],
        ),
        path(
          "/*",
          () => <main>fallback</main>,
          { name: "fallback" },
          () => [
            middleware((ctx, next) => {
              const match = /^\/([a-z]+)-(\d+)$/.exec(ctx.pathname);
              if (!match || !(match[1]! in AUDIENCES)) return next();
              const id = ctx.request.headers.get("x-arm") ?? match[2];
              const target = rewrite(
                `/item/${id}${ctx.url.search}` as `/${string}`,
              );
              const audience = AUDIENCES[match[1]!];
              throw audience ? target.shell(audience) : target;
            }),
          ],
        ),
      ]),
    );
}

const router = buildRouter();

const status = (result: ServeShellRequestResult): string | null =>
  result.response.headers.get("x-document-cache-status");

/**
 * The payload's `metadata.pathname`. A document-cache HIT replays the stored
 * body, which the SSR stub rendered as the Flight payload itself.
 */
function payloadPathname(result: ServeShellRequestResult): unknown {
  const row = (result.flight ?? result.body)
    .split("\n")
    .find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  return (JSON.parse(row!.slice(2)) as { metadata: { pathname: unknown } })
    .metadata.pathname;
}

/** The item handler's text without its render count. */
function itemText(result: ServeShellRequestResult): string | undefined {
  return result.body.match(/item \d+ from=[^ \\"]*/)?.[0];
}

function renderOf(result: ServeShellRequestResult): number | undefined {
  const count = result.body.match(/render=(\d+)/)?.[1];
  return count === undefined ? undefined : Number(count);
}

beforeEach(async () => {
  await resetShellTestState();
  renders = 0;
  errors.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a rewritten request without .shell()", () => {
  it("is never served the target's stored document, and renders at the visitor's URL", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    expect(
      status(await serveShellRequest(router, "/item/1", { cacheStore })),
    ).toBe("MISS");
    expect(
      status(await serveShellRequest(router, "/item/1", { cacheStore })),
    ).toBe("HIT");

    for (let visit = 0; visit < 2; visit++) {
      const rewritten = await serveShellRequest(router, "/public-1", {
        cacheStore,
      });
      // No read, no write: no status header at all.
      expect(status(rewritten)).toBeNull();
      expect(rewritten.response.headers.get("x-rango-rewrite")).toBe("/item/1");
      expect(payloadPathname(rewritten)).toBe("/public-1");
      expect(itemText(rewritten)).toBe("item 1 from=/public-1");
    }
    // The rewrite unwound through the cache middleware without a report.
    expect(errors).toEqual([]);
  });

  it("stores nothing the target's direct visits are served", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(router, "/public-1", { cacheStore });
    const direct = await serveShellRequest(router, "/item/1", { cacheStore });
    expect(status(direct)).toBe("MISS");
    expect(itemText(direct)).toBe("item 1 from=-");
    expect(payloadPathname(direct)).toBe("/item/1");
  });

  it("a navigation is never served the target's stored partial", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const partial = { from: "/item/2" };
    await serveShellRequest(router, "/item/1", { cacheStore, partial });
    expect(
      status(
        await serveShellRequest(router, "/item/1", { cacheStore, partial }),
      ),
    ).toBe("HIT");

    const rewritten = await serveShellRequest(router, "/public-1", {
      cacheStore,
      partial,
    });
    expect(status(rewritten)).toBeNull();
    expect(payloadPathname(rewritten)).toBe("/public-1");
    expect(rewritten.flight).toContain("item 1 from=/public-1");
  });

  it("a custom keyGenerator is asked for the visitor's pass only", async () => {
    const seen: string[] = [];
    const keyed = buildRouter({
      keyGenerator: (url) => {
        seen.push(url.pathname);
        return url.pathname;
      },
    });
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(keyed, "/public-1", { cacheStore });
    expect(seen).toEqual(["/public-1"]);
  });
});

describe('rewrite(...).shell("visitor")', () => {
  it("keys an entry by the visitor's URL, rendered with the visitor's location and rewrittenFrom", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const miss = await serveShellRequest(router, "/visitor-1", { cacheStore });
    expect(status(miss)).toBe("MISS");
    expect(payloadPathname(miss)).toBe("/visitor-1");
    expect(itemText(miss)).toBe("item 1 from=/visitor-1");

    const hit = await serveShellRequest(router, "/visitor-1", { cacheStore });
    expect(status(hit)).toBe("HIT");
    expect(hit.body).toBe(miss.body);
    expect(payloadPathname(hit)).toBe("/visitor-1");

    // Another URL of the same target has its own entry.
    const other = await serveShellRequest(router, "/other-1", { cacheStore });
    expect(status(other)).toBe("MISS");
    expect(itemText(other)).toBe("item 1 from=/other-1");

    // The target's own entry is untouched: a direct visit stores its own.
    const direct = await serveShellRequest(router, "/item/1", { cacheStore });
    expect(status(direct)).toBe("MISS");
    expect(itemText(direct)).toBe("item 1 from=-");
    expect(payloadPathname(direct)).toBe("/item/1");
    // ...and a direct visit's entry is not the visitor's.
    const visitorAgain = await serveShellRequest(router, "/visitor-1", {
      cacheStore,
    });
    expect(status(visitorAgain)).toBe("HIT");
    expect(payloadPathname(visitorAgain)).toBe("/visitor-1");
  });

  it("keeps one entry per target, so a conditional rewrite never serves another arm", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const armA = await serveShellRequest(router, "/visitor-1", { cacheStore });
    expect(status(armA)).toBe("MISS");
    const armB = await serveShellRequest(router, "/visitor-1", {
      cacheStore,
      headers: { "x-arm": "2" },
    });
    expect(status(armB)).toBe("MISS");
    expect(itemText(armB)).toBe("item 2 from=/visitor-1");
    const armAHit = await serveShellRequest(router, "/visitor-1", {
      cacheStore,
    });
    expect(status(armAHit)).toBe("HIT");
    expect(itemText(armAHit)).toBe("item 1 from=/visitor-1");
  });

  it("keys the visitor's search, in any order", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const miss = await serveShellRequest(router, "/visitor-1?b=2&a=1", {
      cacheStore,
    });
    expect(status(miss)).toBe("MISS");
    expect(
      status(
        await serveShellRequest(router, "/visitor-1?a=1&b=2", { cacheStore }),
      ),
    ).toBe("HIT");
    expect(
      status(await serveShellRequest(router, "/visitor-1", { cacheStore })),
    ).toBe("MISS");
  });

  it("stores a render whose Cache-Control came after next(), keyed by the visitor's URL", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const headers = { "x-late": "1" };
    const miss = await serveShellRequest(router, "/visitor-1", {
      cacheStore,
      headers,
    });
    expect(status(miss)).toBe("MISS");
    expect(payloadPathname(miss)).toBe("/visitor-1");
    expect(itemText(miss)).toBe("item 1 from=/visitor-1");
    const hit = await serveShellRequest(router, "/visitor-1", {
      cacheStore,
      headers,
    });
    expect(status(hit)).toBe("HIT");
    expect(payloadPathname(hit)).toBe("/visitor-1");
  });

  it("a stale entry's background re-run refreshes the visitor's entry at the visitor's URL", async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const cacheStore = new MemorySegmentCacheStore();
    const serve = () =>
      serveShellRequest(router, "/visitor-1", {
        cacheStore,
        headers: { "x-swr": "1" },
      });
    const miss = await serve();
    expect(status(miss)).toBe("MISS");
    // Past the s-maxage=1, within the 60 s swr.
    offset += 2_100;
    const stale = await serve();
    expect(status(stale)).toBe("STALE");
    expect(renderOf(stale)).toBe(renderOf(miss));
    const refreshed = await serve();
    expect(status(refreshed)).toBe("HIT");
    expect(renderOf(refreshed)).toBe(renderOf(miss)! + 1);
    expect(payloadPathname(refreshed)).toBe("/visitor-1");
    expect(itemText(refreshed)).toBe("item 1 from=/visitor-1");
    // The re-run wrote the visitor's entry, not the target's.
    expect(
      status(await serveShellRequest(router, "/item/1", { cacheStore })),
    ).toBe("MISS");
  });

  it("a navigation replays the visitor's own stored partial", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const partial = { from: "/item/2" };
    await serveShellRequest(router, "/item/1", { cacheStore, partial });
    const miss = await serveShellRequest(router, "/visitor-1", {
      cacheStore,
      partial,
    });
    expect(status(miss)).toBe("MISS");
    expect(payloadPathname(miss)).toBe("/visitor-1");
    const hit = await serveShellRequest(router, "/visitor-1", {
      cacheStore,
      partial,
    });
    expect(status(hit)).toBe("HIT");
    expect(payloadPathname(hit)).toBe("/visitor-1");
    expect(hit.flight).toContain("item 1 from=/visitor-1");
  });

  it("a custom keyGenerator is asked for the visitor's URL on the rewritten pass", async () => {
    const seen: string[] = [];
    const keyed = buildRouter({
      keyGenerator: (url) => {
        seen.push(url.pathname);
        return url.pathname;
      },
    });
    const cacheStore = new MemorySegmentCacheStore();
    expect(
      status(await serveShellRequest(keyed, "/visitor-1", { cacheStore })),
    ).toBe("MISS");
    expect(
      status(await serveShellRequest(keyed, "/visitor-1", { cacheStore })),
    ).toBe("HIT");
    expect(seen).toEqual([
      "/visitor-1",
      "/visitor-1",
      "/visitor-1",
      "/visitor-1",
    ]);
    // Its entry is not the one the visitor's own pass reads.
    expect(
      status(await serveShellRequest(keyed, "/item/1", { cacheStore })),
    ).toBe("MISS");
  });

  it("a response route's own cache(), keyed by the target, stores no body built from rewrittenFrom", async () => {
    const apiRouter = createRouter()
      .use(createDocumentCacheMiddleware())
      .use((ctx, next) => {
        if (ctx.pathname !== "/api-visitor") return next();
        throw rewrite("/api/item").shell("visitor");
      })
      .routes(
        urls(({ path, cache }) => [
          cache({ ttl: 60 }, () => [
            path.json("/api/item", (ctx) => {
              ctx.header("Cache-Control", "s-maxage=60");
              return { from: ctx.rewrittenFrom?.pathname ?? null };
            }),
          ]),
          path("/api-visitor", () => <main>never</main>),
        ]),
      );
    const cacheStore = new MemorySegmentCacheStore();
    const rewritten = await serveShellRequest(apiRouter, "/api-visitor", {
      cacheStore,
    });
    expect(JSON.parse(rewritten.body)).toEqual({ from: "/api-visitor" });
    // The document cache keyed it by the visitor's URL: served again there.
    const again = await serveShellRequest(apiRouter, "/api-visitor", {
      cacheStore,
    });
    expect(status(again)).toBe("HIT");
    expect(JSON.parse(again.body)).toEqual({ from: "/api-visitor" });
    // The route's cache() is the target's: a direct visit renders its own.
    const direct = await serveShellRequest(apiRouter, "/api/item", {
      cacheStore,
    });
    expect(JSON.parse(direct.body)).toEqual({ from: null });
  });
});

describe('rewrite(...).shell("target")', () => {
  it("reads and stores the target's entry, rendered as a direct visit", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const miss = await serveShellRequest(router, "/target-1", { cacheStore });
    expect(status(miss)).toBe("MISS");
    // The documented caveat: the shared entry shows the target's location.
    expect(payloadPathname(miss)).toBe("/item/1");
    expect(itemText(miss)).toBe("item 1 from=-");

    const direct = await serveShellRequest(router, "/item/1", { cacheStore });
    expect(status(direct)).toBe("HIT");
    expect(direct.body).toBe(miss.body);
    const again = await serveShellRequest(router, "/target-1", { cacheStore });
    expect(status(again)).toBe("HIT");
  });
});
