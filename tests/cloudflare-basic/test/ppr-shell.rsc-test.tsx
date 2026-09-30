// Dogfood (issue #956): the Cache Lab's PPR contract (the runbook in
// pages/cache-lab.tsx, e2e/cache-lab.test.ts) and the request-partitioned
// /ppr-tiered and /ppr-tiered-nested routes (e2e/ppr-shell.test.ts) in-process through
// serveShellRequest — a real capture on the MISS and a real HIT after it.
// The routers are built from the app's own pieces, since src/router.tsx does
// not import in bare Vitest (test/FINDINGS.md): CacheLabPage with the ppr
// options and loader urls.tsx declares, the "cache-lab" profile from
// router.tsx, and the app's /api/cache/invalidate endpoint, driven with
// dispatch; PprTieredPage under the cache() key() urls.tsx gives it.
import { beforeEach, describe, expect, it } from "vitest";
import { createRouter, urls } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { dispatch, shellCacheKey } from "@rangojs/router/testing";
import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "@rangojs/router/testing/flight";
import { apiPatterns } from "../src/api/urls.js";
import { CACHE_LAB_TAGS } from "../src/cache-lab-contract.js";
import { CacheLabPulseLoader } from "../src/cache-lab-data.js";
import type { AppBindings } from "../src/env.js";
import { CacheLabPage } from "../src/pages/cache-lab.js";
import {
  PprTieredLayout,
  PprTieredPage,
  pprTier,
} from "../src/pages/ppr-shell.js";

const env = {} as AppBindings;

beforeEach(() => resetShellTestState());

function cacheLabRouter() {
  return createRouter<AppBindings>({
    cache: { store: new MemorySegmentCacheStore() },
    cacheProfiles: { "cache-lab": { ttl: 3600, swr: 300 } },
  }).routes(
    urls(({ path, include, loader }) => [
      include("/api", apiPatterns, { name: "api" }),
      path(
        "/cache-lab",
        CacheLabPage,
        {
          name: "cacheLab",
          ppr: { ttl: 3600, swr: 300, tags: [CACHE_LAB_TAGS.shell] },
        },
        () => [loader(CacheLabPulseLoader)],
      ),
    ]),
  );
}

/** Each product card's cache token, from a Flight payload. */
function tokens(flight: string | undefined): { alpha: string; beta: string } {
  // The tail carries replayed segments as escaped Flight fragments.
  const text = (flight ?? "").replaceAll('\\"', '"');
  const token = (id: string): string => {
    const match = new RegExp(
      `"id":"${id}","product":\\{"cacheToken":"([^"]+)"`,
    ).exec(text);
    if (!match?.[1]) throw new Error(`no ${id} cache token in the payload`);
    return match[1];
  };
  return { alpha: token("alpha"), beta: token("beta") };
}

describe("Cache Lab PPR shell through serveShellRequest (cloudflare-basic)", () => {
  it("HITs keep products baked; invalidating a product or the shell recaptures", async () => {
    const router = cacheLabRouter();
    const url = "/cache-lab?probe=dogfood";
    const serve = () => serveShellRequest(router, url, { env });
    const invalidate = async (tag: string) => {
      const response = await dispatch(router, {
        env,
        request: new Request("http://localhost/api/cache/invalidate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tags: [tag] }),
        }),
      });
      expect(response.status).toBe(200);
    };
    const shell = (result: ServeShellRequestResult) => ({
      status: result.shellStatus,
      tokens: tokens(result.flight),
    });

    const first = await serve();
    expect(first.shellStatus).toBe("MISS");
    const baseline = tokens(first.flight);

    const hit = await serve();
    expect(hit.shellStatus).toBe("HIT");
    // The prelude froze the products; the tail replays them unchanged.
    expect(tokens(hit.prelude)).toEqual(baseline);
    expect(tokens(hit.flight)).toEqual(baseline);

    await invalidate(CACHE_LAB_TAGS.productAlpha);
    const afterAlpha = shell(await serve());
    expect(afterAlpha.status).toBe("MISS");
    expect(afterAlpha.tokens.alpha).not.toBe(baseline.alpha);
    expect(afterAlpha.tokens.beta).toBe(baseline.beta);
    expect(shell(await serve())).toEqual({
      status: "HIT",
      tokens: afterAlpha.tokens,
    });

    await invalidate(CACHE_LAB_TAGS.shell);
    expect(shell(await serve())).toEqual({
      status: "MISS",
      tokens: afterAlpha.tokens,
    });
  }, 30_000);
});

describe("request-partitioned PPR shell through serveShellRequest (cloudflare-basic)", () => {
  it("each tier captures and HITs its own shell", async () => {
    const router = createRouter<AppBindings>({
      cache: { store: new MemorySegmentCacheStore() },
    }).routes(
      urls(({ path, cache }) => [
        cache({ ttl: 300, key: (ctx) => `tier:${pprTier(ctx)}` }, () => [
          path("/ppr-tiered", PprTieredPage, {
            name: "pprTiered",
            ppr: { ttl: 300, swr: 120 },
          }),
        ]),
      ]),
    );
    const serve = (tier: string) =>
      serveShellRequest(router, "/ppr-tiered", {
        env,
        headers: { "x-ppr-tier": tier },
      });

    const goldMiss = await serve("gold");
    expect(goldMiss.shellStatus).toBe("MISS");
    // The key the serve path resolved: the route's key() result, namespaced
    // (#975) and encoded.
    expect(goldMiss.key).toBe("localhost/ppr-tiered:shell|key%3Atier%253Agold");
    expect(goldMiss.key).toBe(
      shellCacheKey("http://localhost/ppr-tiered", undefined, "tier:gold"),
    );
    expect(await goldMiss.readEntry()).not.toBeNull();
    const silverMiss = await serve("silver");
    expect(silverMiss.shellStatus).toBe("MISS");
    expect(silverMiss.flight).toContain("tier-silver");
    expect(silverMiss.flight).not.toContain("tier-gold");

    for (const [own, other] of [
      ["gold", "silver"],
      ["silver", "gold"],
    ] as const) {
      const hit = await serve(own);
      expect(hit.shellStatus).toBe("HIT");
      expect(hit.prelude).toContain(`tier-${own}`);
      expect(hit.body).not.toContain(`tier-${other}`);
    }
  });

  // Issue #970: a cache() nested in the keyed one keeps the partition; its
  // own key() composes with the outer one.
  it("a ppr route under nested cache() scopes gets one shell per outer partition, under the composed key", async () => {
    const router = createRouter<AppBindings>({
      cache: { store: new MemorySegmentCacheStore() },
    }).routes(
      urls(({ path, layout, cache }) => [
        cache({ ttl: 300, key: (ctx) => `tier:${pprTier(ctx)}` }, () => [
          layout(PprTieredLayout, () => [
            cache({ ttl: 300, key: () => "layout:v2" }, () => [
              path("/ppr-tiered-nested", PprTieredPage, {
                name: "pprTieredNested",
                ppr: { ttl: 300, swr: 120 },
              }),
            ]),
          ]),
        ]),
      ]),
    );
    const serve = (tier: string) =>
      serveShellRequest(router, "/ppr-tiered-nested", {
        env,
        headers: { "x-ppr-tier": tier },
      });

    const goldMiss = await serve("gold");
    expect(goldMiss.shellStatus).toBe("MISS");
    expect(goldMiss.key).toBe(
      shellCacheKey("http://localhost/ppr-tiered-nested", undefined, [
        "tier:gold",
        "layout:v2",
      ]),
    );
    const silverMiss = await serve("silver");
    expect(silverMiss.shellStatus).toBe("MISS");
    expect(silverMiss.flight).toContain("layout-tier-silver");
    expect(silverMiss.flight).not.toContain("tier-gold");

    for (const [own, other] of [
      ["gold", "silver"],
      ["silver", "gold"],
    ] as const) {
      const hit = await serve(own);
      expect(hit.shellStatus).toBe("HIT");
      expect(hit.prelude).toContain(`layout-tier-${own}`);
      expect(hit.body).not.toContain(`tier-${other}`);
    }
  });
});
