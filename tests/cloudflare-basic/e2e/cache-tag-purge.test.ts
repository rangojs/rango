import { expect, test, type APIRequestContext } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// Serial: the purge tests share one cached route + the CF cache across the
// fixture server, so an invalidation in one test must not race another.
test.describe.configure({ mode: "serial" });

/**
 * Purge mode (CFCacheStoreOptions.tagPurge) against the real CFCacheStore in
 * workerd. The purge-mode store lives on a dedicated cache({ store }) boundary
 * (src/purge-store.ts) so the marker-mode cache-tag suite keeps its semantics.
 *
 * workerd has no purge-by-tag, so the wired tagPurge is a recording stub. That
 * makes exactly purge mode's contract observable end to end:
 * - updateTag() hands the hook the namespaced entry Cache-Tags (one batched
 *   call), which a real deployment forwards to Cloudflare's purge API
 *   (createCloudflareZonePurge).
 * - An L1 entry that SURVIVES (here: because the stub purges nothing) keeps
 *   serving — the per-read KV marker lookup is skipped. Contrast with
 *   cache-tag.test.ts, where the same updateTag makes the next read fresh via
 *   the marker.
 */

function definePurgeTests(f: Fixture) {
  async function ts(request: APIRequestContext, path: string): Promise<number> {
    const res = await request.get(f.url(path));
    expect(res.status()).toBe(200);
    return (await res.json()).ts;
  }

  test("updateTag hands tagPurge the namespaced entry Cache-Tags", async ({
    request,
  }) => {
    // Seed the purge-store boundary and wait for the async write to land.
    const first = await ts(request, "/test/purge-tagged-json");
    await expect
      .poll(() => ts(request, "/test/purge-tagged-json"), { timeout: 8000 })
      .toBe(first);

    const cleared = await request.get(f.url("/__test/clear-purge-log"));
    expect(cleared.status()).toBe(200);

    // updateTag reaches the purge store through the explicit-tagged-store
    // registry (the boundary above registered it) and AWAITS the purge hook.
    const inv = await request.get(f.url("/test/invalidate-tag/cf-purge-items"));
    expect(inv.status()).toBe(200);

    const log = await (await request.get(f.url("/__test/purge-log"))).json();
    expect(log.calls).toContainEqual(["rg:purge-e2e:e:cf-purge-items"]);
  });

  test("a surviving L1 entry keeps serving after updateTag (eviction is delegated to the purge)", async ({
    request,
  }) => {
    const first = await ts(request, "/test/purge-tagged-json");
    await expect
      .poll(() => ts(request, "/test/purge-tagged-json"), { timeout: 8000 })
      .toBe(first);

    const inv = await request.get(f.url("/test/invalidate-tag/cf-purge-items"));
    expect(inv.status()).toBe(200);

    // The KV marker WAS written (the marker-mode store would now miss), but in
    // purge mode the L1 hit trusts the un-purged entry: same ts, twice.
    expect(await ts(request, "/test/purge-tagged-json")).toBe(first);
    expect(await ts(request, "/test/purge-tagged-json")).toBe(first);
  });
}

test.describe("CF purge-mode tag invalidation (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  definePurgeTests(f);
});

test.describe("CF purge-mode tag invalidation (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  definePurgeTests(f);
});
