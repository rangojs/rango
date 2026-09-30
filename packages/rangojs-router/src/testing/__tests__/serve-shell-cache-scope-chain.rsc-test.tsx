/**
 * Route records and PPR shells under nested cache() scopes, through
 * `serveShellRequest` and `shellCacheKey`, the public primitives:
 * - #975: a `key()` result is namespaced in the record key and the shell
 *   partition, and `shellCacheKey` builds the same key production reads;
 * - #974: an enclosing `condition()` gates a nested scope's record and the
 *   ppr shell, enclosing `tags` tag the nested record and the shell captured
 *   from it, and an enclosing scope on another store partitions the nested
 *   record and the shell by that store's keyGenerator result.
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
  type ServeShellRequestOptions,
} from "../flight.entry.js";
import { runInRequestContext, shellCacheKey } from "../index.js";
import {
  createRouter,
  createVar,
  updateTag,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  type SegmentCacheStore,
} from "../../cache/index.js";
import type { CacheGetResult } from "../../cache/types.js";
import type { RequestContext } from "../../server/request-context.js";
import { source } from "./fixtures/shell-request-data.js";

function tierOf(ctx: { request: Request }): string {
  return ctx.request.headers.get("x-tier") ?? "none";
}

function localeOf(ctx: { request: Request }): string {
  return ctx.request.headers.get("x-locale") ?? "none";
}

/** Whether the /gated routes' outer condition() allows caching. */
const gate = { allow: false };
/** Page runs, across tests. */
const runs = { gated: 0 };

/** The store the /localized routes' outer cache() writes to. */
const localizedStore = new MemorySegmentCacheStore({
  keyGenerator: (ctx: RequestContext, defaultKey: string) =>
    `${defaultKey}|${localeOf(ctx)}`,
});
/** The store the /localized routes' inner cache() writes to. */
const nestedStore = new MemorySegmentCacheStore();

function regionOf(ctx: { request: Request }): string {
  return ctx.request.headers.get("x-region") ?? "us";
}

/**
 * Stores whose keyGenerator returns the default key for its default value
 * (locale `en`, region `us`): the /positional route sits under both.
 */
const defaultLocaleStore = new MemorySegmentCacheStore({
  keyGenerator: (ctx: RequestContext, defaultKey: string) =>
    localeOf(ctx) === "en" ? defaultKey : `${defaultKey}|${localeOf(ctx)}`,
});
const defaultRegionStore = new MemorySegmentCacheStore({
  keyGenerator: (ctx: RequestContext, defaultKey: string) =>
    regionOf(ctx) === "us" ? defaultKey : `${defaultKey}|${regionOf(ctx)}`,
});
/** The store of the /app-localized route's inner cache(). */
const appNestedStore = new MemorySegmentCacheStore();

/**
 * What the handlers render: middleware's copy of the headers (makeRouter).
 * A handler read of ctx.request.headers under cache() or a ppr capture
 * throws (#976); the key() and keyGenerators above read the headers and keep
 * each partition's copy apart.
 */
const Tier = createVar<string>();
const Locale = createVar<string>();
const Region = createVar<string>();

function makeRouter() {
  return createRouter({})
    .use(async (ctx, next) => {
      ctx.set(Tier, tierOf(ctx));
      ctx.set(Locale, localeOf(ctx));
      ctx.set(Region, regionOf(ctx));
      await next();
    })
    .routes(
      urls(({ path, cache }) => [
        cache({ ttl: 300, key: (ctx) => `tier:${tierOf(ctx)}` }, () => [
          path(
            "/ns/tiered",
            (ctx: HandlerContext) => <p>{`tiered-${ctx.get(Tier)}`}</p>,
            { name: "nsTiered", ppr: true },
          ),
        ]),
        // A key() returning request input as is.
        cache({ ttl: 300, key: (ctx) => tierOf(ctx) }, () => [
          path("/ns/bare", () => <p>bare page</p>, { name: "nsBare" }),
        ]),
        cache({ ttl: 300 }, () => [
          path("/ns/victim", () => <p>victim page</p>, { name: "nsVictim" }),
        ]),
        cache({ condition: () => gate.allow }, () => [
          cache({ ttl: 300 }, () => [
            path("/gated/page", () => <p>{`gated-run-${++runs.gated}`}</p>, {
              name: "gatedPage",
              ppr: true,
            }),
          ]),
        ]),
        cache({ tags: ["outer-catalog"] }, () => [
          cache({ ttl: 300, tags: ["inner-prices"] }, () => [
            path(
              "/tagged/page",
              () => <p>{`tagged@g${source.generation}`}</p>,
              {
                name: "taggedPage",
                ppr: true,
              },
            ),
          ]),
        ]),
        cache({ store: localizedStore }, () => [
          cache({ store: nestedStore, ttl: 300 }, () => [
            path(
              "/localized/page",
              (ctx: HandlerContext) => <p>{`locale-${ctx.get(Locale)}`}</p>,
              { name: "localizedPage", ppr: true },
            ),
          ]),
        ]),
        cache({ store: defaultLocaleStore }, () => [
          cache({ store: defaultRegionStore, ttl: 300 }, () => [
            path(
              "/positional/page",
              (ctx: HandlerContext) => (
                <p>{`locale-${ctx.get(Locale)}-region-${ctx.get(Region)}`}</p>
              ),
              { name: "positionalPage", ppr: true },
            ),
          ]),
        ]),
        // A plain cache() on the app store, which the app-store test sets up
        // with a keyGenerator.
        cache({ ttl: 300 }, () => [
          cache({ store: appNestedStore, ttl: 300 }, () => [
            path(
              "/app-localized/page",
              (ctx: HandlerContext) => <p>{`app-locale-${ctx.get(Locale)}`}</p>,
              { name: "appLocalizedPage", ppr: true },
            ),
          ]),
        ]),
      ]),
    );
}

beforeEach(async () => {
  source.generation = 1;
  gate.allow = false;
  await resetShellTestState();
  await localizedStore.clear();
  await nestedStore.clear();
  await defaultLocaleStore.clear();
  await defaultRegionStore.clear();
  await appNestedStore.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(cacheStore: SegmentCacheStore = new MemorySegmentCacheStore()) {
  const router = makeRouter();
  const serve = (
    url: string,
    extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) => serveShellRequest(router, url, { cacheStore, ...extra });
  return { cacheStore, serve };
}

const tier = (name: string) => ({ headers: { "x-tier": name } });
const locale = (name: string) => ({ headers: { "x-locale": name } });

describe("serveShellRequest: namespaced key() results (#975)", () => {
  it("the record key and the shell partition namespace the key() result; shellCacheKey builds the production key", async () => {
    const { serve, cacheStore } = setup();
    const url = "http://localhost/ns/tiered";

    const gold = await serve("/ns/tiered", tier("gold"));
    expect(gold.shellStatus).toBe("MISS");
    expect(gold.key).toBe(shellCacheKey(url, undefined, "tier:gold"));
    expect(gold.key).toBe("localhost/ns/tiered:shell|key%3Atier%253Agold");
    expect(await cacheStore.get("key:tier%3Agold")).not.toBeNull();

    const hit = await serve("/ns/tiered", tier("gold"));
    expect(hit.shellStatus).toBe("HIT");
    expect(hit.prelude).toContain("tiered-gold");
  });

  it("a raw key() result can't write a route's content under another route's default key", async () => {
    const { serve, cacheStore } = setup();

    await serve("/ns/bare", tier("doc:localhost/ns/victim"));
    expect(await cacheStore.get("doc:localhost/ns/victim")).toBeNull();
    expect(
      await cacheStore.get("key:doc%3Alocalhost%2Fns%2Fvictim"),
    ).not.toBeNull();

    const victim = await serve("/ns/victim");
    expect(victim.flight).toContain("victim page");
    expect(victim.flight).not.toContain("bare page");
  });
});

describe("serveShellRequest: a nested cache() inherits the enclosing scopes (#974)", () => {
  it("an enclosing condition() returning false: no record, no shell, the handler runs every time", async () => {
    const { serve, cacheStore } = setup();
    const url = "http://localhost/gated/page";
    runs.gated = 0;

    const first = await serve("/gated/page");
    const second = await serve("/gated/page");
    expect(first.shellStatus).not.toBe("HIT");
    expect(second.shellStatus).not.toBe("HIT");
    expect(second.flight).toContain("gated-run-2");
    expect(await cacheStore.getShell!(shellCacheKey(url))).toBeNull();
    expect(await cacheStore.get("doc:localhost/gated/page")).toBeNull();

    // Allowed, the nested scope caches and the shell captures as before.
    gate.allow = true;
    expect((await serve("/gated/page")).shellStatus).toBe("MISS");
    const hit = await serve("/gated/page");
    expect(hit.shellStatus).toBe("HIT");
    expect(hit.prelude).toContain("gated-run-3");
  });

  it("enclosing tags tag the nested record and its shell: updateTag(outer) evicts both", async () => {
    const { serve, cacheStore } = setup();
    const recordKey = "doc:localhost/tagged/page";

    expect((await serve("/tagged/page")).shellStatus).toBe("MISS");
    const hit = await serve("/tagged/page");
    expect(hit.shellStatus).toBe("HIT");
    expect(hit.prelude).toContain("tagged@g1");
    const record = (await cacheStore.get(recordKey)) as CacheGetResult | null;
    expect(record?.data.tags).toEqual(
      expect.arrayContaining(["outer-catalog", "inner-prices"]),
    );
    source.generation = 2;

    await runInRequestContext(() => updateTag("outer-catalog"), {
      cacheStore,
    });
    expect(await cacheStore.get(recordKey)).toBeNull();
    expect(
      await cacheStore.getShell!(shellCacheKey("http://localhost/tagged/page")),
    ).toBeNull();
    expect((await serve("/tagged/page")).shellStatus).toBe("MISS");
    const fresh = await serve("/tagged/page");
    expect(fresh.shellStatus).toBe("HIT");
    expect(fresh.prelude).toContain("tagged@g2");
  });

  it("an enclosing scope on another store partitions the nested record and the shell by its keyGenerator", async () => {
    const { serve } = setup();
    const url = "http://localhost/localized/page";

    const en = await serve("/localized/page", locale("en"));
    expect(en.shellStatus).toBe("MISS");
    const de = await serve("/localized/page", locale("de"));
    expect(de.shellStatus).toBe("MISS");
    expect(de.flight).toContain("locale-de");
    expect(de.flight).not.toContain("locale-en");
    expect(en.key).toBe(
      shellCacheKey(url, undefined, {
        generated: ["doc:localhost/localized/page|en"],
      }),
    );

    for (const [own, other] of [
      ["en", "de"],
      ["de", "en"],
    ] as const) {
      const hit = await serve("/localized/page", locale(own));
      expect(hit.shellStatus).toBe("HIT");
      expect(hit.prelude).toContain(`locale-${own}`);
      expect(hit.body).not.toContain(`locale-${other}`);
    }
    for (const name of ["en", "de"]) {
      expect(
        await nestedStore.get(
          `doc%3Alocalhost%2Flocalized%2Fpage%7C${name}|doc%3Alocalhost%2Flocalized%2Fpage`,
        ),
      ).not.toBeNull();
    }
  });
  it("keyGenerator parts keep their position: a store returning the default key never merges two partitions", async () => {
    const { serve } = setup();
    const url = "http://localhost/positional/page";
    const visit = (localeName: string, region: string) => ({
      headers: { "x-locale": localeName, "x-region": region },
    });

    const enDe = await serve("/positional/page", visit("en", "de"));
    expect(enDe.shellStatus).toBe("MISS");
    // Before, both kept one part "doc:localhost/positional/page|de" and the
    // de-locale visitor HIT the en visitor's shell.
    const deUs = await serve("/positional/page", visit("de", "us"));
    expect(deUs.shellStatus).toBe("MISS");
    expect(deUs.flight).toContain("locale-de-region-us");
    expect(deUs.flight).not.toContain("locale-en");

    const generated = "doc:localhost/positional/page|de";
    expect(enDe.key).toBe(
      shellCacheKey(url, undefined, { generated: ["", generated] }),
    );
    expect(deUs.key).toBe(
      shellCacheKey(url, undefined, { generated: [generated, ""] }),
    );
    // Both default: the unpartitioned shell, as before.
    const enUs = await serve("/positional/page", visit("en", "us"));
    expect(enUs.key).toBe(shellCacheKey(url));
  });

  it("an outer cache() on the app store partitions a nested cache({ store })", async () => {
    const { serve } = setup(
      new MemorySegmentCacheStore({
        keyGenerator: (ctx: RequestContext, defaultKey: string) =>
          `${defaultKey}|${localeOf(ctx)}`,
      }),
    );

    expect((await serve("/app-localized/page", locale("en"))).shellStatus).toBe(
      "MISS",
    );
    const de = await serve("/app-localized/page", locale("de"));
    expect(de.shellStatus).toBe("MISS");
    expect(de.flight).toContain("app-locale-de");
    expect(de.flight).not.toContain("app-locale-en");
    for (const name of ["en", "de"]) {
      expect(
        await appNestedStore.get(
          `doc%3Alocalhost%2Fapp-localized%2Fpage%7C${name}|doc%3Alocalhost%2Fapp-localized%2Fpage`,
        ),
      ).not.toBeNull();
    }
  });
});
