import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";
import { guardHydrationErrors } from "@shared/e2e";

// End-to-end coverage for the render-callable cacheTag() form (#648): a baked
// server component (BlogLayout) calls cacheTag() with NO cache()/"use cache" in
// its tree. Under PPR capture the tag rides _requestTags into the shell entry, so
// updateTag()/revalidateTag() of that tag drops the shell — PPR's DERIVATIVE
// invalidation, with zero first-class ppr tag API. Runs in BOTH the dev worker
// and the built preview worker. See docs/design/ppr-shell-resume.md.
//
// Isolation: BlogLayout tags the shell `pprblog-shell-<probe>` only when the
// `shelltag` query param is present, and the shell key includes search params, so
// each test owns a distinct shell entry AND a distinct tag — a revalidate here
// never touches a sibling /ppr-blog shell (the ppr-shell suite primes /ppr-blog
// with no probe, so its tag is never set). The probe is unique PER RUN (see
// uniqueProbe) so persisted miniflare KV from a prior run cannot pre-warm the key.

// Serial within each describe (matches cache-tag.test.ts): shell capture is a
// background task and tag invalidation writes shared KV markers — running these
// concurrently against one dev worker makes cold captures race and the eviction
// poll flake. Each test still isolates its own shell key via a distinct probe.
test.describe.configure({ mode: "serial" });

const HTML_HEADERS = { Accept: "text/html" };

/** Poll a URL until the shell cache reports HIT (the background capture landed). */
async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 20000 });
}

/**
 * The layout's per-render token (BlogLayout `data-shell-render`) from a HIT
 * document. The layout sits in the ppr route's cache() record, so the token
 * names the render that wrote the record the shell was captured from.
 */
async function hitRenderToken(
  request: Page["request"],
  url: string,
): Promise<string> {
  const res = await request.get(url, { headers: HTML_HEADERS });
  expect(res.headers()["x-rango-shell"]).toBe("HIT");
  const token = /data-shell-render="([^"]+)"/.exec(await res.text())?.[1];
  expect(token).toBeTruthy();
  return token!;
}

/**
 * GET `invalidateUrl` (an awaited updateTag(), a deterministic marker write),
 * then poll the document until it MISSes. Polling absorbs KV marker
 * propagation on the dev worker.
 */
async function evict(
  request: Page["request"],
  invalidateUrl: string,
  url: string,
): Promise<void> {
  const inv = await request.get(invalidateUrl);
  expect(inv.status()).toBe(200);
  await expect
    .poll(
      async () =>
        (await request.get(url, { headers: HTML_HEADERS })).headers()[
          "x-rango-shell"
        ],
      { timeout: 15000 },
    )
    .toBe("MISS");
}

/**
 * The eviction cycle for a shell whose tag only a server component recorded.
 *
 * 1. Prime: the first document GET MISSes (a virgin shell key). The capture
 *    replays the route's cache() record, which carries the tags its content
 *    recorded (#957).
 * 2. Warm the shell to a HIT.
 * 3. updateTag() evicts it.
 * 4. It recaptures and HITs again. The tag also invalidated the cache()
 *    record, so the layout rendered fresh (a new token); before, the recapture
 *    replayed the pre-update record.
 * 5. The recaptured shell is re-tagged, so a second updateTag() evicts it
 *    too: the shell keeps tracking the tag across generations.
 */
async function assertEvictionCycle(
  request: Page["request"],
  url: string,
  invalidateUrl: string,
): Promise<void> {
  const first = await request.get(url, { headers: HTML_HEADERS });
  expect(first.status()).toBe(200);
  expect(first.headers()["x-rango-shell"]).toBe("MISS");

  await warmToHit(request, url);
  const renderBefore = await hitRenderToken(request, url);

  await evict(request, invalidateUrl, url);

  await warmToHit(request, url);
  expect(await hitRenderToken(request, url)).not.toBe(renderBefore);

  await evict(request, invalidateUrl, url);
  await warmToHit(request, url);
}

// A fresh probe per test run. The shell key includes the search string and
// miniflare KV persists across runs, so a fixed probe would HIT a shell captured
// by a prior run and the "first GET is a MISS" assertion would flake. A unique
// token guarantees a virgin shell key AND a virgin tag (never read/invalidated
// before this run), so both the capture and the eviction are deterministic.
function uniqueProbe(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function describeTagEviction(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";

  test.describe(`ppr cacheTag shell eviction (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("a render-tagged PPR shell is evicted by updateTag(), then recaptures", async ({
      request,
    }) => {
      // BlogLayout's handler calls cacheTag(tag) with no cache()/"use cache"
      // around it; the shell carries the tag only because it rendered it.
      const probe = uniqueProbe("evict");
      const tag = `pprblog-shell-${probe}`;
      await assertEvictionCycle(
        request,
        f.url(`/ppr-blog?shelltag=${probe}`),
        f.url(`/test/invalidate-tag/${tag}`),
      );
    });

    test("a shell tagged AFTER an await in an async server component is evicted by updateTag(), then recaptures (#676)", async ({
      request,
    }) => {
      // The async twin of the sync case above: BlogLayout renders AsyncShellTagger,
      // an async bake-lane server component that records its cacheTag() only after
      // an await. Before the write-barrier snapshot moved behind the quiesce gate,
      // that post-await tag was dropped from the shell entry and this invalidation
      // could not evict — the exact #676 loss. Distinct probe/param => distinct
      // shell key and tag, so it never touches the sync case or a sibling shell.
      // The record's serialization re-renders AsyncShellTagger, so its
      // post-await tag lands on the cache() record the capture replays (#957).
      const probe = uniqueProbe("async-evict");
      const tag = `pprblog-async-shell-${probe}`;
      await assertEvictionCycle(
        request,
        f.url(`/ppr-blog?asyncshelltag=${probe}`),
        f.url(`/test/invalidate-tag/${tag}`),
      );
    });

    test("an untagged sibling probe shell survives a different tag's invalidation (isolation)", async ({
      request,
    }) => {
      // This probe tags its shell `pprblog-shell-keep-<token>`. Invalidating a
      // DIFFERENT tag must not evict it — the shell is only dropped by ITS OWN
      // render-recorded tag.
      const probe = uniqueProbe("keep");
      const url = f.url(`/ppr-blog?shelltag=${probe}`);
      await request.get(url, { headers: HTML_HEADERS });
      await warmToHit(request, url);

      const inv = await request.get(
        f.url(`/test/invalidate-tag/${uniqueProbe("unrelated-tag")}`),
      );
      expect(inv.status()).toBe(200);

      // Still a HIT: the unrelated tag does not carry this shell.
      const res = await request.get(url, { headers: HTML_HEADERS });
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
    });

    test("the render-tagged shell hydrates cleanly on a HIT (no hydration errors)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      using __ = guardHydrationErrors(page);

      const url = f.url(`/ppr-blog?shelltag=${uniqueProbe("hydrate")}`);
      await warmToHit(page.request, url);

      await page.goto(url);
      await waitForHydration(page);

      await expect(testId(page, "blog-title")).toHaveText("Blog");
      // Flight can hydrate this boundary before fizz's $RC/$RV reveal cleanup.
      // During that normal seam the visible node and hidden S:n copy coexist;
      // wait globally so a permanently orphaned copy remains a test failure.
      const sidebar = testId(page, "blog-sidebar");
      await expect(sidebar).toHaveCount(1);
      await expect(sidebar).toBeVisible();
    });
  });
}

describeTagEviction("dev");
describeTagEviction("build");
