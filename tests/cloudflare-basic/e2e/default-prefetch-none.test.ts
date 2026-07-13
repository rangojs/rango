import { expect, test } from "@playwright/test";
import { isPrefetchRequest } from "@rangojs/router/testing/e2e";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration } from "./helper";

function isPrefetchRuntimeRequest(url: string): boolean {
  const pathname = decodeURIComponent(new URL(url).pathname);
  return (
    /\/browser\/prefetch\/runtime\.(?:js|ts)$/.test(pathname) ||
    /\/assets\/runtime-[^/]+\.js$/.test(pathname)
  );
}

/**
 * Manual prefetch mode: this app sets createRouter({ defaultPrefetch: "none" })
 * (src/router.tsx), overriding the production viewport default. This pins both
 * sides of the manual-mode contract:
 *
 *   1. Bare Links and opted-in delegated plain anchors issue no speculative
 *      prefetches because the resolved router default is "none".
 *   2. A per-Link strategy still opts in; manual mode only changes the fallback.
 *
 * Every speculative prefetch carries the X-Rango-Prefetch header
 * (browser/prefetch/fetch.ts), which is what both tests key on.
 */

function runDefaultPrefetchNoneSpec(f: Fixture): void {
  test("bare Links and opted-in plain anchors do not prefetch under defaultPrefetch: 'none'", async ({
    page,
  }) => {
    const prefetchRequests: string[] = [];
    page.on("request", (req) => {
      if (isPrefetchRequest(req)) {
        prefetchRequests.push(req.url());
      }
    });

    // Home renders bare Links, an opted-in plain anchor, and explicit hover
    // Links, which cannot fire without a hover. A viewport fallback would
    // enqueue the bare Links and delegated anchor.
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // The idle-gated viewport queue would drain during this window.
    await page.waitForTimeout(2000);
    expect(prefetchRequests).toHaveLength(0);
  });

  test("a per-Link prefetch prop still opts in under manual mode", async ({
    page,
  }) => {
    await page.goto(f.url("/pt-layout/from"));
    await waitForHydration(page);

    const prefetchRequest = page.waitForRequest(
      (req) => isPrefetchRequest(req) && req.url().includes("/pt-layout/to"),
    );
    await page.getByTestId("pt-to-link").hover();

    const req = await prefetchRequest;
    expect(req.url()).toContain("_rsc_partial");
  });

  test("an offscreen viewport override waits for intersection", async ({
    page,
  }) => {
    const targetRequests: string[] = [];
    const runtimeRequests: string[] = [];
    page.on("request", (req) => {
      if (isPrefetchRequest(req) && req.url().includes("observer-facade=1")) {
        targetRequests.push(req.url());
      }
      if (isPrefetchRuntimeRequest(req.url())) {
        runtimeRequests.push(req.url());
      }
    });

    await page.goto(f.url("/pt-layout/from"));
    await waitForHydration(page);

    const link = page.getByTestId("pt-offscreen-viewport-link");
    const top = await link.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    expect(top).toBeGreaterThan(920);
    await page.waitForTimeout(500);
    expect(targetRequests).toHaveLength(0);
    expect(runtimeRequests).toHaveLength(0);

    const prefetchRequest = page.waitForRequest(
      (req) =>
        isPrefetchRequest(req) && req.url().includes("observer-facade=1"),
    );
    await link.scrollIntoViewIfNeeded();
    const req = await prefetchRequest;

    expect(new URL(req.url()).searchParams.get("_rsc_partial")).toBe("true");
    expect(runtimeRequests).toHaveLength(1);
  });
}

test.describe("default-prefetch-none (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runDefaultPrefetchNoneSpec(f);
});

test.describe("default-prefetch-none (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runDefaultPrefetchNoneSpec(f);
});
