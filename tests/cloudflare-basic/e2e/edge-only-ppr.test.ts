import { expect, test, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";
import { guardHydrationErrors } from "@shared/e2e";
import { assertShellStatus } from "@rangojs/router/testing/e2e";

// Edge-only ppr shells (KV-less CFCacheStore). This suite runs ONLY under
// playwright.edge-only.config.ts: its servers set RANGO_E2E_EDGE_ONLY_CACHE=1,
// which makes src/router.tsx construct the app-level CFCacheStore WITHOUT the
// KV binding — shells then capture into and serve from the per-colo Cache API
// alone (workerd's cache simulator here). Before the unlock, a KV-less store
// declared the shell family inert and every ppr route was a permanent MISS;
// these tests pin the full MISS -> capture -> HIT round trip and clean
// hydration with no KV anywhere in the store.
//
// Tag-eviction semantics for KV-less stores (purge mode, RYOW memo, the
// no-eviction warning) are unit-pinned in cf-cache-store-shell.test.ts; this
// suite pins the serving path on the real worker.

const HTML_HEADERS = { Accept: "text/html" };

/** Poll a URL until the shell cache reports HIT (the background capture landed). */
async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    assertShellStatus(
      {
        headers: new Headers({
          "x-rango-shell": res.headers()["x-rango-shell"] ?? "",
        }),
      },
      "HIT",
    );
  }).toPass({ timeout: 20000 });
}

function defineEdgeOnlySpec(f: Fixture, probe: string) {
  test("document MISS captures, then a later GET HITs from the Cache API alone", async ({
    request,
  }) => {
    const url = f.url(`/ppr-shell?probe=${probe}-roundtrip`);
    const first = await request.get(url, { headers: HTML_HEADERS });
    expect(first.status()).toBe(200);
    expect(first.headers()["x-rango-shell"]).toBe("MISS");
    // Axis 1 streamed the live document while the capture ran in background.
    const html = await first.text();
    expect(html).toContain("PPR Shell Demo");

    await warmToHit(request, url);
  });

  test("tagged BUILD-time shell declines (tagHistoryInert): first request is MISS, runtime capture then owns the route", async ({
    request,
  }) => {
    // No probe param: a non-excluded search param would fail the build-shell
    // manifest match before the tag gate ever ran, making MISS prove nothing.
    // KV-backed, this exact URL serves x-rango-shell: HIT on the FIRST
    // request (ppr-shell.test.ts "build-time shell: the FIRST request…" /
    // the evict test) — that pin plus this one bracket the decline branch.
    const url = f.url("/ppr-shell/prerendered-evict/gamma");
    const first = await request.get(url, { headers: HTML_HEADERS });
    expect(first.status()).toBe(200);
    // The tagged immutable build entry has no eviction path on a KV-less
    // store (purge cannot delete a build asset, no durable markers), so the
    // manifest gate declines it and the route keeps runtime-capture
    // semantics. The live document still streams (axis 1).
    expect(first.headers()["x-rango-shell"]).toBe("MISS");
    expect(await first.text()).toContain("Evictable shell content for gamma");

    // Producer A owns the route: the MISS scheduled a runtime capture whose
    // L1-only entry (tagged, no purge → ttl/swr freshness) later requests HIT.
    await warmToHit(request, url);
  });

  test("HIT page hydrates with zero errors on the L1-only shell", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const url = f.url(`/ppr-shell?probe=${probe}-hydrate`);
    await warmToHit(page.request, url);

    // The navigation itself must be the HIT under test — without this, the
    // markup assertions below would also pass on a fresh axis-1 MISS.
    const navigation = await page.goto(url);
    expect(navigation?.headers()["x-rango-shell"]).toBe("HIT");
    await waitForHydration(page);

    // Static shell material resumed from the stored prelude.
    await expect(testId(page, "ppr-shell-header")).toHaveText("PPR Shell Demo");
    // The loader hole stays LIVE per request even on a HIT.
    const price = testId(page, "ppr-price");
    await expect(price).toHaveCount(1);
    await expect(price).toContainText("Live price:");
    // Interactivity proves hydration attached to the resumed markup.
    const counter = testId(page, "ppr-counter");
    await counter.click();
    await expect(counter).toHaveText("count: 1");
  });
}

test.describe("edge-only ppr shells", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineEdgeOnlySpec(f, "edgedev");
});

test.describe("edge-only ppr shells (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineEdgeOnlySpec(f, "edgeprod");
});
