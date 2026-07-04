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
      const probe = uniqueProbe("evict");
      const tag = `pprblog-shell-${probe}`;
      const url = f.url(`/ppr-blog?shelltag=${probe}`);

      // 1. Prime: the first HTML GET MISSes (virgin shell key); the background
      // capture records the render-called cacheTag(tag) into the shell entry.
      const first = await request.get(url, { headers: HTML_HEADERS });
      expect(first.status()).toBe(200);
      expect(first.headers()["x-rango-shell"]).toBe("MISS");

      // 2. Warm until that capture lands as a HIT.
      await warmToHit(request, url);

      // 3. Invalidate the component's tag. updateTag() is awaited (deterministic
      // marker write) — the shell carries this tag ONLY because a server
      // component rendered it, with no cache()/"use cache" involved.
      const inv = await request.get(f.url(`/test/invalidate-tag/${tag}`));
      expect(inv.status()).toBe(200);

      // 4. The render-tagged shell is now evicted: the next document GET MISSes
      // (recapture). Poll to absorb KV marker propagation on the dev worker.
      await expect
        .poll(
          async () =>
            (await request.get(url, { headers: HTML_HEADERS })).headers()[
              "x-rango-shell"
            ],
          { timeout: 15000 },
        )
        .toBe("MISS");

      // 5. It recaptures and HITs again (re-tagged), so the shell keeps tracking
      // the tag across generations.
      await warmToHit(request, url);
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
      await expect(testId(page, "blog-sidebar")).toBeVisible();
    });
  });
}

describeTagEviction("dev");
describeTagEviction("build");
