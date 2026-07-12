import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

// On-demand (ISR-style) prerender: a Passthrough + `{ onDemand }` route serves
// the LIVE handler until router.prerender() renders + stores a durable overlay
// entry, after which the same URL short-circuits to the frozen prerender payload
// (loaders still run fresh). The in-memory prerender store persists across
// requests within the one node process backing each fixture, so the trigger and
// the serve path share it in dev and in the production preview build alike.

const stamp = (page: Page) =>
  page.locator('[data-testid="od-stamp"]').textContent();

const plainStamp = (page: Page) =>
  page.locator('[data-testid="od-plain-stamp"]').textContent();

const plainLoader = (page: Page) =>
  page.locator('[data-testid="od-plain-loader"]').textContent();

const uniqueSlug = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Trigger the plain onDemand route; qs carries the onlyIfStale/invalidateTag ops.
const plainTrigger = (f: Fixture, page: Page, slug: string, qs = "") =>
  page.request.get(f.url(`/od-plain-trigger/${slug}${qs}`));

// A trigger response must be { ok: true, status: "rendered" }.
async function expectRendered(res: APIResponse): Promise<void> {
  const json = await res.json();
  expect(json, JSON.stringify(json)).toMatchObject({
    ok: true,
    status: "rendered",
  });
}

// Steps a–d from the task: unbuilt slug serves live (stamp differs each call),
// trigger renders + stores, subsequent serves come from the overlay (source
// "prerender", ctx.onDemand true, identical stamp), loader still fresh.
async function exerciseOnDemandRefresh(f: Fixture, page: Page) {
  const slug = `fresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // (a) An unbuilt, untriggered slug falls through to the live handler. Two
  // requests differ because the live handler re-renders each time.
  await page.goto(f.url(`/on-demand/${slug}`));
  await waitForHydration(page);
  await expect(page.locator('[data-testid="od-source"]')).toHaveText("live");
  await expect(page.locator('[data-testid="od-slug"]')).toHaveText(slug);
  await expect(page.locator('[data-testid="od-ondemand"]')).toHaveText("false");
  const liveStamp1 = await stamp(page);

  await page.goto(f.url(`/on-demand/${slug}`));
  await waitForHydration(page);
  await expect(page.locator('[data-testid="od-source"]')).toHaveText("live");
  const liveStamp2 = await stamp(page);
  expect(liveStamp2).not.toBe(liveStamp1);

  // (b) Trigger the requestless on-demand render. router.prerender() returns
  // { ok: true, status: "rendered" }, serialized as JSON by the trigger route.
  const triggerRes = await page.request.get(f.url(`/od-trigger/${slug}`));
  expect(triggerRes.ok()).toBe(true);
  await expectRendered(triggerRes);

  // (c) The same URL now serves the durable overlay entry: source "prerender",
  // ctx.onDemand true, and a stamp that stays identical across serves (the
  // frozen payload short-circuits the live handler).
  await page.goto(f.url(`/on-demand/${slug}`));
  await waitForHydration(page);
  await expect(page.locator('[data-testid="od-source"]')).toHaveText(
    "prerender",
  );
  await expect(page.locator('[data-testid="od-ondemand"]')).toHaveText("true");
  await expect(page.locator('[data-testid="od-slug"]')).toHaveText(slug);
  const prStamp1 = await stamp(page);

  await page.goto(f.url(`/on-demand/${slug}`));
  await waitForHydration(page);
  await expect(page.locator('[data-testid="od-source"]')).toHaveText(
    "prerender",
  );
  const prStamp2 = await stamp(page);
  expect(prStamp2).toBe(prStamp1);

  // (d) Loaders are never baked — they run fresh even on an overlay hit.
  await expect(
    page.locator('[data-testid="prerender-loader-data"]'),
  ).toHaveText("prerender-loader-data");
  await expect(
    page.locator('[data-testid="prerender-loader-test"]'),
  ).toHaveText("true");
}

async function exerciseKnownPrerender(f: Fixture, page: Page) {
  await page.goto(f.url("/on-demand/baked"));
  await waitForHydration(page);

  await expect(page.locator('[data-testid="od-source"]')).toHaveText(
    "prerender",
  );
  await expect(page.locator('[data-testid="od-slug"]')).toHaveText("baked");
}

async function exercisePersonalizationGuard(f: Fixture, page: Page) {
  const slug = `personalized-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const source = page.locator('[data-testid="od-personalized-source"]');

  await page.goto(f.url(`/on-demand-personalized/${slug}`));
  await waitForHydration(page);
  await expect(source).toHaveText(`live:${slug}`);

  const response = await page.request.get(
    f.url(`/od-personalized-trigger/${slug}`),
  );
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    status: "skipped-personalized",
  });

  await page.goto(f.url(`/on-demand-personalized/${slug}`));
  await waitForHydration(page);
  await expect(source).toHaveText(`live:${slug}`);
}

// PLAIN (non-Passthrough) onDemand route: after a trigger stores an overlay
// entry, serves replay the frozen payload (identical od-plain-stamp) while the
// route's loader still runs per request (od-plain-loader differs). Unique slug:
// the onlyIfStale exercise below mutates its own entry, and fullyParallel
// workers would race a shared one.
async function exercisePlainLoaderFreshness(f: Fixture, page: Page) {
  const slug = uniqueSlug("loader-fresh");

  const triggerRes = await plainTrigger(f, page, slug);
  expect(triggerRes.ok()).toBe(true);
  await expectRendered(triggerRes);

  await page.goto(f.url(`/on-demand-plain/${slug}`));
  await waitForHydration(page);
  await expect(page.locator('[data-testid="od-plain-source"]')).toHaveText(
    "prerender",
  );
  await expect(page.locator('[data-testid="od-plain-slug"]')).toHaveText(slug);
  const stamp1 = await plainStamp(page);
  const loader1 = await plainLoader(page);
  expect(loader1).toBeTruthy();

  await page.goto(f.url(`/on-demand-plain/${slug}`));
  await waitForHydration(page);
  await expect(page.locator('[data-testid="od-plain-source"]')).toHaveText(
    "prerender",
  );
  const stamp2 = await plainStamp(page);
  const loader2 = await plainLoader(page);

  // Frozen payload: the producer did not re-run between the two serves.
  expect(stamp2).toBe(stamp1);
  // Loaders are never baked: the loader value advanced on the overlay hit.
  expect(loader2).not.toBe(loader1);
}

// Trigger companions: onlyIfStale (cron-sweep opt-in) returns already-fresh on
// a fresh entry and renders again once invalidateTags marked it stale.
async function exerciseOnlyIfStaleAndInvalidate(f: Fixture, page: Page) {
  const slug = uniqueSlug("only-if-stale");
  const tag = `od-plain:${slug}`;

  const rendered = await plainTrigger(f, page, slug);
  await expectRendered(rendered);

  const fresh = await plainTrigger(f, page, slug, "?onlyIfStale=1");
  await expect(fresh.json()).resolves.toMatchObject({
    ok: true,
    status: "already-fresh",
  });

  const invalidated = await plainTrigger(
    f,
    page,
    slug,
    `?invalidateTag=${encodeURIComponent(tag)}`,
  );
  await expect(invalidated.json()).resolves.toMatchObject({
    invalidated: tag,
  });

  const reRendered = await plainTrigger(f, page, slug, "?onlyIfStale=1");
  await expectRendered(reRendered);
}

// SWR scheduling: a STALE overlay hit (ttl 1 on the swr route) still serves
// 200 but schedules prerender.onRevalidate via waitUntil; the router config
// pushes the JSON target into swrLog, served by /od-swr-log.
async function exerciseSwrScheduling(f: Fixture, page: Page) {
  const readLog = async (): Promise<
    Array<{ route: string; params: Record<string, string> }>
  > => {
    const res = await page.request.get(f.url("/od-swr-log"));
    expect(res.ok()).toBe(true);
    return res.json();
  };

  const baseline = (await readLog()).length;

  const triggerRes = await page.request.get(f.url("/od-swr-trigger/swr"));
  expect(triggerRes.ok()).toBe(true);
  await expectRendered(triggerRes);

  // ttl is 1s — after 1.3s the overlay entry is stale.
  await page.waitForTimeout(1300);

  const staleRes = await page.request.get(f.url("/on-demand-swr/swr"));
  expect(staleRes.status()).toBe(200);

  await expect
    .poll(
      async () =>
        (await readLog())
          .slice(baseline)
          .some((entry) => entry.params.slug === "swr"),
      { timeout: 5000 },
    )
    .toBe(true);
}

test.describe("on-demand prerender (dev mode)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("live handler until triggered, then durable overlay serves prerender", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await exerciseOnDemandRefresh(f, page);
  });

  test("known slug serves prerender without any trigger", async ({ page }) => {
    using _ = expectNoPageError(page);
    await exerciseKnownPrerender(f, page);
  });

  test("personalized producer is skipped and live fallback remains", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await exercisePersonalizationGuard(f, page);
  });

  // Dev keeps the live fall-through on a store miss: the plain producer runs
  // in-request through the dev prerender endpoint instead of 404ing.
  test("plain onDemand route: unbaked param renders live (dev fall-through)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const slug = uniqueSlug("unbaked");
    const response = await page.goto(f.url(`/on-demand-plain/${slug}`));
    expect(response?.status()).toBe(200);
    await waitForHydration(page);
    await expect(page.locator('[data-testid="od-plain-slug"]')).toHaveText(
      slug,
    );
  });

  test("plain onDemand route: loaders resolve fresh on overlay hit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await exercisePlainLoaderFreshness(f, page);
  });

  test("onlyIfStale and tag invalidation", async ({ page }) => {
    await exerciseOnlyIfStaleAndInvalidate(f, page);
  });

  test("stale overlay hit schedules onRevalidate (swr)", async ({ page }) => {
    await exerciseSwrScheduling(f, page);
  });
});

test.describe("on-demand prerender (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("live handler until triggered, then durable overlay serves prerender", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await exerciseOnDemandRefresh(f, page);
  });

  // (e) The "baked" slug was returned by getParams() and pre-rendered at build
  // time, so it serves the prerender payload with no trigger. Build renders have
  // ctx.onDemand false (static build, not an on-demand refresh).
  test("known slug serves prerender without any trigger", async ({ page }) => {
    using _ = expectNoPageError(page);
    await exerciseKnownPrerender(f, page);
  });

  test("personalized producer is skipped and live fallback remains", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await exercisePersonalizationGuard(f, page);
  });

  // Regression pin for gateOnDemandProducer: a PLAIN onDemand route with no
  // overlay entry and no baked manifest entry must 404 on a live production
  // request — pre-fix, the retained producer ran live and returned 200.
  test("plain onDemand route: unbaked param 404s until refreshed", async ({
    page,
  }) => {
    const slug = uniqueSlug("unbaked");

    const missRes = await page.request.get(f.url(`/on-demand-plain/${slug}`));
    expect(missRes.status()).toBe(404);

    const triggerRes = await plainTrigger(f, page, slug);
    expect(triggerRes.ok()).toBe(true);
    await expectRendered(triggerRes);

    await page.goto(f.url(`/on-demand-plain/${slug}`));
    await waitForHydration(page);
    await expect(page.locator('[data-testid="od-plain-source"]')).toHaveText(
      "prerender",
    );
    await expect(page.locator('[data-testid="od-plain-slug"]')).toHaveText(
      slug,
    );
  });

  test("plain onDemand route: loaders resolve fresh on overlay hit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await exercisePlainLoaderFreshness(f, page);
  });

  test("onlyIfStale and tag invalidation", async ({ page }) => {
    await exerciseOnlyIfStaleAndInvalidate(f, page);
  });

  test("stale overlay hit schedules onRevalidate (swr)", async ({ page }) => {
    await exerciseSwrScheduling(f, page);
  });
});
