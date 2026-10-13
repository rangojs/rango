/**
 * A request middleware rewrote to a `ppr` route (#1146), through the
 * production request handler (serveShellRequest): a URL's shared shell is
 * read and written only by requests on that URL, and
 * `rewrite(...).shell("visitor" | "target")` picks a shell for the
 * rewritten request.
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
import { shellCacheKey, visitorShellCacheKey } from "../index.js";
import {
  createLoader,
  createRouter,
  createVar,
  rewrite,
  urls,
  type HandlerContext,
  type RewriteShell,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
} from "../../cache/index.js";

const PublicPath = createVar<string>();
const ItemLoader = createLoader(async (ctx) => ({
  item: String(ctx.params.id),
}));

/** `/<audience>-<id>` rewrites to `/item/<id>`, keeping the search. */
const AUDIENCES: Record<string, RewriteShell | undefined> = {
  public: undefined,
  alias: undefined,
  visitor: "visitor",
  other: "visitor",
  target: "target",
};

const router = createRouter().routes(
  urls(({ path, middleware, loader }) => [
    path(
      "/item/:id",
      (ctx: HandlerContext<{ id: string }>) => (
        <main>
          {`item ${ctx.params.id} public=${ctx.get(PublicPath) ?? "-"} from=${ctx.rewrittenFrom?.pathname ?? "-"}`}
        </main>
      ),
      { name: "item", ppr: true },
      () => [loader(ItemLoader)],
    ),
    path(
      "/*",
      () => <main>fallback</main>,
      { name: "fallback" },
      () => [
        middleware((ctx, next) => {
          const match = /^\/([a-z]+)-(\d+)$/.exec(ctx.pathname);
          if (!match || !(match[1]! in AUDIENCES)) return next();
          ctx.set(PublicPath, ctx.pathname);
          const target = rewrite(
            `/item/${match[2]}${ctx.url.search}` as `/${string}`,
          );
          const audience = AUDIENCES[match[1]!];
          throw audience ? target.shell(audience) : target;
        }),
      ],
    ),
  ]),
);

function payloadPathname(flight: string | undefined): unknown {
  const row = flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  return (JSON.parse(row!.slice(2)) as { metadata: { pathname: unknown } })
    .metadata.pathname;
}

/** The item handler's text, as the prelude or the live render shows it. */
function itemText(
  result: Awaited<ReturnType<typeof serveShellRequest>>,
): string | undefined {
  return (result.prelude ?? result.body).match(
    /item 1 public=[^ \\"]* from=[^\\"]*/,
  )?.[0];
}

beforeEach(() => resetShellTestState());

describe("a rewritten request without .shell() (A1 + B3)", () => {
  it("renders the visitor's pathname on every request, warm or cold", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const first = await serveShellRequest(router, "/public-1", { cacheStore });
    const second = await serveShellRequest(router, "/public-1", {
      cacheStore,
    });
    for (const result of [first, second]) {
      // No shell read, no capture: no x-rango-shell header at all.
      expect(result.shellStatus).toBeNull();
      expect(payloadPathname(result.flight)).toBe("/public-1");
      expect(itemText(result)).toBe("item 1 public=/public-1 from=/public-1");
    }
    expect(
      await cacheStore.getShell(shellCacheKey(router, "/item/1")),
    ).toBeNull();
  });

  it("never reads the target's shared shell", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    // A direct visit captures the target's shell.
    expect(
      (await serveShellRequest(router, "/item/1", { cacheStore })).shellStatus,
    ).toBe("MISS");
    expect(
      (await serveShellRequest(router, "/item/1", { cacheStore })).shellStatus,
    ).toBe("HIT");

    const rewritten = await serveShellRequest(router, "/public-1", {
      cacheStore,
    });
    expect(rewritten.shellStatus).toBeNull();
    expect(rewritten.prelude).toBeUndefined();
    expect(payloadPathname(rewritten.flight)).toBe("/public-1");
  });

  it("bakes no first-pass variable into the target's shared shell", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(router, "/public-1", { cacheStore });
    await serveShellRequest(router, "/alias-1", { cacheStore });

    const direct = await serveShellRequest(router, "/item/1", { cacheStore });
    expect(direct.shellStatus).toBe("MISS");
    const hit = await serveShellRequest(router, "/item/1", { cacheStore });
    expect(hit.shellStatus).toBe("HIT");
    expect(itemText(hit)).toBe("item 1 public=- from=-");
    expect(hit.body).not.toContain("/public-1");
    expect(hit.body).not.toContain("/alias-1");
    expect(payloadPathname(hit.flight)).toBe("/item/1");
  });

  it("a navigation replays no record keyed by another URL", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(router, "/item/1", { cacheStore });
    const navigation = await serveShellRequest(router, "/public-1", {
      cacheStore,
      partial: { from: "/item/2" },
    });
    expect(navigation.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "rewritten",
    });
    expect(navigation.flight).toContain(
      "item 1 public=/public-1 from=/public-1",
    );
    expect(payloadPathname(navigation.flight)).toBe("/public-1");
  });
});

describe('rewrite(...).shell("visitor")', () => {
  it("keys and captures a shell per visitor URL, with rewrittenFrom set", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const miss = await serveShellRequest(router, "/visitor-1", { cacheStore });
    expect(miss.shellStatus).toBe("MISS");
    expect(miss.key).toBe(
      visitorShellCacheKey(router, "/visitor-1", "/item/1"),
    );
    expect(payloadPathname(miss.flight)).toBe("/visitor-1");

    const hit = await serveShellRequest(router, "/visitor-1", { cacheStore });
    expect(hit.shellStatus).toBe("HIT");
    expect(hit.key).toBe(miss.key);
    // Captured with the visitor's location and first-pass state, which the
    // key covers; the tail replays the captured pathname.
    expect(itemText(hit)).toBe("item 1 public=/visitor-1 from=/visitor-1");
    expect(payloadPathname(hit.flight)).toBe("/visitor-1");
    expect((await hit.readEntry())?.pathname).toBe("/visitor-1");

    // Another URL of the same target has its own shell.
    const other = await serveShellRequest(router, "/other-1", { cacheStore });
    expect(other.shellStatus).toBe("MISS");
    expect(other.key).toBe(visitorShellCacheKey(router, "/other-1", "/item/1"));
    const otherHit = await serveShellRequest(router, "/other-1", {
      cacheStore,
    });
    expect(otherHit.shellStatus).toBe("HIT");
    expect(itemText(otherHit)).toBe("item 1 public=/other-1 from=/other-1");

    // The target's own shell is untouched: a direct visit captures its own.
    const direct = await serveShellRequest(router, "/item/1", { cacheStore });
    expect(direct.shellStatus).toBe("MISS");
    expect(direct.key).toBe(shellCacheKey(router, "/item/1"));
  });

  it("serves an entry only to a request that renders the location it captured", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const miss = await serveShellRequest(router, "/visitor-1", { cacheStore });
    const entry = await miss.readEntry();
    expect(entry?.pathname).toBe("/visitor-1");
    // The visitor's entry under the target's own key: a direct visit renders
    // /item/1, so it is a MISS, never a HIT that hydrates at /visitor-1.
    await cacheStore.putShell(shellCacheKey(router, "/item/1"), entry!, 60);
    const direct = await serveShellRequest(router, "/item/1", { cacheStore });
    expect(direct.shellStatus).toBe("MISS");
    expect(payloadPathname(direct.flight)).toBe("/item/1");
  });

  it("keys the visitor's search and seeds the shell with it", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const miss = await serveShellRequest(router, "/visitor-1?b=2&a=1", {
      cacheStore,
    });
    expect(miss.key).toBe(
      visitorShellCacheKey(router, "/visitor-1?a=1&b=2", "/item/1?b=2&a=1"),
    );
    const hit = await serveShellRequest(router, "/visitor-1?b=2&a=1", {
      cacheStore,
    });
    expect(hit.shellStatus).toBe("HIT");
    // The forwarded target search is normalized too: one shell, any order.
    const reordered = await serveShellRequest(router, "/visitor-1?a=1&b=2", {
      cacheStore,
    });
    expect(reordered.shellStatus).toBe("HIT");
    const bare = await serveShellRequest(router, "/visitor-1", { cacheStore });
    expect(bare.shellStatus).toBe("MISS");
  });

  it("a navigation replays the visitor's own record", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(router, "/visitor-1", { cacheStore });
    const navigation = await serveShellRequest(router, "/visitor-1", {
      cacheStore,
      partial: { from: "/item/2" },
    });
    expect(navigation.replayStatus).toEqual({
      outcome: "HIT",
      freshness: "fresh",
    });
    expect(navigation.flight).toContain(
      "item 1 public=/visitor-1 from=/visitor-1",
    );
    expect(payloadPathname(navigation.flight)).toBe("/visitor-1");
  });
});

describe("a visitor-keyed shell and the other shared caches", () => {
  it("the document cache does not store a HIT at the target's key", async () => {
    const docRouter = createRouter({})
      .use(createDocumentCacheMiddleware())
      .use((ctx, next) => {
        if (ctx.pathname !== "/summer") return next();
        throw rewrite("/doc-item").shell("visitor");
      })
      .routes(
        urls(({ path, middleware }) => [
          path(
            "/doc-item",
            (ctx: HandlerContext) => (
              <main>{`doc item from=${ctx.rewrittenFrom?.pathname ?? "-"}`}</main>
            ),
            { ppr: true },
            () => [
              middleware(async (ctx, next) => {
                if (ctx.request.headers.get("x-doc") === "1") {
                  ctx.header("Cache-Control", "s-maxage=60");
                }
                await next();
              }),
            ],
          ),
          path("/summer", () => <main>never</main>),
        ]),
      );
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(docRouter, "/summer", { cacheStore });
    const hit = await serveShellRequest(docRouter, "/summer", {
      cacheStore,
      headers: { "x-doc": "1" },
    });
    expect(hit.shellStatus).toBe("HIT");
    expect(hit.prelude).toContain("doc item from=/summer");
    // Stored at /doc-item, it would serve /summer's page to direct visitors.
    const direct = await serveShellRequest(docRouter, "/doc-item", {
      cacheStore,
      headers: { "x-doc": "1" },
    });
    expect(direct.response.headers.get("x-document-cache-status")).toBe("MISS");
    expect(direct.body).not.toContain("/summer");
  });

  it("a loader's own cache() inside the capture does not store rewrittenFrom", async () => {
    const FromLoader = createLoader(
      async (ctx) => ctx.rewrittenFrom?.pathname ?? "-",
    );
    const loaderRouter = createRouter({})
      .use((ctx, next) => {
        if (ctx.pathname !== "/summer") return next();
        throw rewrite("/loader-item").shell("visitor");
      })
      .routes(
        urls(({ path, loader, cache }) => [
          path(
            "/loader-item",
            () => <main>loader item</main>,
            { ppr: true },
            () => [
              loader(FromLoader, { ssr: false }, () => [cache({ ttl: 60 })]),
            ],
          ),
          path("/summer", () => <main>never</main>),
        ]),
      );
    const cacheStore = new MemorySegmentCacheStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await serveShellRequest(loaderRouter, "/summer", { cacheStore });
      const direct = await serveShellRequest(loaderRouter, "/loader-item", {
        cacheStore,
      });
      expect(direct.body).not.toContain("/summer");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe('rewrite(...).shell("target")', () => {
  it("reads and captures the target's shared shell, as before", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const miss = await serveShellRequest(router, "/target-1", { cacheStore });
    expect(miss.shellStatus).toBe("MISS");
    expect(miss.key).toBe(shellCacheKey(router, "/item/1"));
    expect(payloadPathname(miss.flight)).toBe("/target-1");

    const hit = await serveShellRequest(router, "/target-1", { cacheStore });
    expect(hit.shellStatus).toBe("HIT");
    // The documented caveat: the shared shell shows the target's location.
    expect(payloadPathname(hit.flight)).toBe("/item/1");
    expect(itemText(hit)).toBe("item 1 public=/target-1 from=-");
    expect(
      (await serveShellRequest(router, "/item/1", { cacheStore })).shellStatus,
    ).toBe("HIT");
  });
});
