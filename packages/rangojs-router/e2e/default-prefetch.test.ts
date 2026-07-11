import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, isPrefetchRequest } from "./helper";

/**
 * Default-on prefetch: Links without a `prefetch` prop fall back to the
 * router-wide default, which is "viewport" unless createRouter configures
 * `defaultPrefetch`. This app leaves the option unset, so it dogfoods the
 * default-on seat (cloudflare-basic dogfoods the `defaultPrefetch: "none"`
 * opt-out).
 *
 * The page under test matters: /hash-navigation renders ONLY bare Links (its
 * own link-different-path -> /blog plus the RootLayout nav Links) — no
 * explicit viewport/render props that would prefetch under the old opt-in
 * default too. A prefetch observed here can only come from the fallback.
 * Every speculative prefetch carries X-Rango-Prefetch
 * (browser/prefetch/fetch.ts); per-Link opt-out under this default is pinned
 * by "Link prefetch='none' does not send prefetch request"
 * (link-behavior.test.ts).
 */
function runDefaultPrefetchSpec(f: ReturnType<typeof useFixture>): void {
  test("a bare Link viewport-prefetches under the default", async ({
    page,
  }) => {
    const prefetchRequest = page.waitForRequest(
      (req) =>
        isPrefetchRequest(req) &&
        req.url().includes("_rsc_partial") &&
        new URL(req.url()).pathname.endsWith("/blog"),
    );

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);

    // link-different-path (bare, in viewport) -> /blog prefetches once the
    // app goes idle.
    const req = await prefetchRequest;
    expect(new URL(req.url()).searchParams.get("_rsc_partial")).toBe("true");
  });

  test("initial RSC payload carries the built-in default strategy", async ({
    page,
  }) => {
    const res = await page.request.get(f.url("/?__rsc=1"), {
      headers: { "X-Rango-State": "test:1" },
    });
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/"defaultPrefetch"\s*:\s*"viewport"/);
  });

  test("an offscreen bare Link waits for viewport intersection", async ({
    page,
  }) => {
    const targetRequests: string[] = [];
    page.on("request", (req) => {
      if (
        isPrefetchRequest(req) &&
        new URL(req.url()).pathname.endsWith("/blog/post-5")
      ) {
        targetRequests.push(req.url());
      }
    });

    await page.goto(f.url("/hash-navigation"));
    await waitForHydration(page);

    const link = page.getByTestId("link-default-prefetch-offscreen");
    const top = await link.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    expect(top).toBeGreaterThan(920);
    await page.waitForTimeout(500);
    expect(targetRequests).toHaveLength(0);

    const prefetchRequest = page.waitForRequest(
      (req) =>
        isPrefetchRequest(req) &&
        new URL(req.url()).pathname.endsWith("/blog/post-5"),
    );
    await link.scrollIntoViewIfNeeded();
    const req = await prefetchRequest;

    expect(new URL(req.url()).searchParams.get("_rsc_partial")).toBe("true");
  });
}

test.describe("default-prefetch", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runDefaultPrefetchSpec(f);
});

test.describe("default-prefetch (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runDefaultPrefetchSpec(f);
});
