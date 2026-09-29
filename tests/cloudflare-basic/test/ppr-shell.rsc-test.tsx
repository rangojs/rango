// Dogfood (issue #956): the Cache Lab's PPR contract (the runbook in
// pages/cache-lab.tsx, e2e/cache-lab.test.ts) in-process through
// serveShellRequest — a real capture on the MISS and a real HIT after it.
// The router is built from the app's own pieces, since src/router.tsx does not
// import in bare Vitest (test/FINDINGS.md): CacheLabPage with the ppr options
// and loader urls.tsx declares, the "cache-lab" profile from router.tsx, and
// the app's /api/cache/invalidate endpoint, driven with dispatch.
import { beforeEach, describe, expect, it } from "vitest";
import { createRouter, urls } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { dispatch } from "@rangojs/router/testing";
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
