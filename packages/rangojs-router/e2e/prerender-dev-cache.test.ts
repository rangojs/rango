import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Dev prerender result cache (#654): /__rsc_prerender memoizes rendered
 * payloads keyed by router-instance identity, so repeated requests between
 * HMR edits skip the module re-import render and getParams work. The
 * `x-rango-prerender-cache` header exposes HIT/MISS for observability.
 *
 * Determinism note: the runtime dev store ALWAYS sends `routeName`
 * (see prerender-api-design.md, Dev Mode), so these requests deliberately
 * OMIT it — the cache key's routeName dimension makes that key unreachable
 * by any page-navigation warming from sibling suites sharing the dev server.
 *
 * The edit-invalidation half of the contract (edit → MISS + fresh content)
 * lives in prerender-hmr.test.ts (local-only, file-watcher territory).
 */

test.describe("prerender dev cache", () => {
  // isolatedServer: the MISS/HIT sequence needs a dev server whose endpoint
  // cache no other suite (or a sibling checkout's shared-port server) can
  // touch. The fixture spawns a dedicated dev server on a discovered port.
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test("endpoint serves MISS then HIT with a byte-identical body", async ({
    request,
  }) => {
    const url = f.url("/__rsc_prerender?pathname=/docs");

    // First-ever request for this key on this server: deterministically a
    // MISS regardless of any concurrent invalidation (a churned identity
    // still has no cached body for the key).
    const first = await request.get(url);
    expect(first.status()).toBe(200);
    expect(first.headers()["x-rango-prerender-cache"]).toBe("MISS");
    const firstBody = await first.text();

    // The payload is the real prerender wire format, not an error shape.
    const parsed = JSON.parse(firstBody);
    expect(Array.isArray(parsed.segments)).toBe(true);
    expect(parsed.segments.length).toBeGreaterThan(0);

    // HIT via paired poll: request twice per attempt and require the second
    // response to be a HIT byte-identical to the first. A legitimate
    // identity churn between the pair (dep-optimizer re-optimization, a
    // sibling process touching a watched file) retries the pair; a broken
    // cache never returns HIT and the poll times out.
    await expect
      .poll(
        async () => {
          const a = await request.get(url);
          const aBody = await a.text();
          const b = await request.get(url);
          const bBody = await b.text();
          return b.headers()["x-rango-prerender-cache"] === "HIT" &&
            bBody === aBody
            ? "HIT-identical"
            : `retry(${b.headers()["x-rango-prerender-cache"]})`;
        },
        { timeout: 15000 },
      )
      .toBe("HIT-identical");
  });

  test("one render warms the intercept variant key too", async ({
    request,
  }) => {
    // /docs/getting-started: fresh pathname for this test (still no
    // routeName, so no sibling warming). The main-variant render must warm
    // intercept=1 as well — matchForPrerender computes intercept segments
    // unconditionally, so the second variant costs no extra render.
    //
    // Paired poll: each attempt renders/warms via the main variant, then
    // requests the intercept variant. On the (typical) first attempt an
    // intercept HIT can only come from the main render's warming — the
    // strong claim. Later attempts only occur under a concurrent identity
    // churn; the precise both-keys-from-one-render semantics are pinned
    // deterministically by the dev-prerender-cache unit tests.
    const mainUrl = f.url("/__rsc_prerender?pathname=/docs/getting-started");
    const interceptUrl = f.url(
      "/__rsc_prerender?pathname=/docs/getting-started&intercept=1",
    );
    await expect
      .poll(
        async () => {
          const main = await request.get(mainUrl);
          if (main.status() !== 200) return `main-${main.status()}`;
          const intercept = await request.get(interceptUrl);
          if (intercept.status() !== 200) return `int-${intercept.status()}`;
          return intercept.headers()["x-rango-prerender-cache"];
        },
        { timeout: 15000 },
      )
      .toBe("HIT");
  });
});

test.describe("prerender dev cache absent (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });

  test("prerendered route serves the frozen artifact with no dev-cache header; the dev endpoint does not exist", async ({
    request,
  }) => {
    const page = await request.get(f.url("/docs"));
    expect(page.status()).toBe(200);
    expect(page.headers()["x-rango-prerender-cache"]).toBeUndefined();
    expect(await page.text()).toContain("pre-rendered documentation content");

    // Production serves prerendered payloads from the built manifest inside
    // the worker — the dev endpoint must not exist (and must not leak the
    // dev-cache header) in a production serve.
    const endpoint = await request.get(
      f.url("/__rsc_prerender?pathname=/docs"),
    );
    expect(endpoint.headers()["x-rango-prerender-cache"]).toBeUndefined();
    expect(endpoint.headers()["content-type"] ?? "").not.toContain(
      "application/json",
    );
  });
});
