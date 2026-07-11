import { expect, test, type Page } from "@playwright/test";
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
  const triggerJson = await triggerRes.json();
  expect(triggerJson, JSON.stringify(triggerJson)).toMatchObject({
    ok: true,
    status: "rendered",
  });

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
});
