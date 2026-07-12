import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

// On-demand (ISR-style) prerender via a KV-backed writable overlay.
//
// Flow, exercised in BOTH dev and production:
//   (a) GET /guides/<slug> for a slug NOT in getParams -> Passthrough live
//       handler runs; guide-source="live" and guide-rendered-at differs across
//       two requests (the live handler re-executes every time).
//   (b) GET /guide-trigger/<slug> -> router.prerender() renders the build
//       handler requestlessly and stores it in the KV overlay; JSON is
//       { ok: true, status: "rendered" }.
//   (c) GET /guides/<slug> again -> served from the overlay, short-circuiting
//       the live handler: guide-source="prerender", guide-ondemand="true", and
//       guide-rendered-at is now STABLE across requests (frozen overlay payload).
//   (d) A built slug (routing) still serves the build-time prerender.
//
// Each run uses a fresh slug so a persisted miniflare KV overlay from a prior
// run cannot make step (a) start already-prerendered. Dev/prod overlays are
// additionally buildId-scoped, so they never collide even with a shared slug.
const uniqueSlug = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const SLUG = uniqueSlug("ondemand");

// PLAIN (non-Passthrough) fixtures. Fresh slugs per run: the miniflare KV
// overlay persists across runs of the same build (reuseExistingServer), so a
// fixed slug could start already-prerendered / already-logged.
const PLAIN_SLUG = uniqueSlug("unbaked");
const SWR_SLUG = uniqueSlug("swr");

async function gotoGuide(
  page: import("@playwright/test").Page,
  f: Fixture,
  slug: string,
) {
  await page.goto(f.url(`/guides/${slug}`));
  await waitForHydration(page);
}

function defineOnDemandFlow(f: Fixture) {
  test("live handler serves, then on-demand trigger populates the overlay", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // (a) Not in getParams -> live handler. guide-source="live".
    await gotoGuide(page, f, SLUG);
    await expect(testId(page, "guide-source")).toHaveText("live");
    await expect(testId(page, "guide-title")).toHaveText(`Guide: ${SLUG}`);
    const firstRenderedAt = await testId(
      page,
      "guide-rendered-at",
    ).textContent();

    // The live handler re-executes: rendered-at differs on a second request.
    await gotoGuide(page, f, SLUG);
    await expect(testId(page, "guide-source")).toHaveText("live");
    const secondRenderedAt = await testId(
      page,
      "guide-rendered-at",
    ).textContent();
    expect(secondRenderedAt).not.toBe(firstRenderedAt);

    // (b) Trigger the requestless on-demand render.
    const res = await page.request.get(f.url(`/guide-trigger/${SLUG}`));
    expect(res.ok()).toBe(true);
    const json = await res.json();
    expect(json, JSON.stringify(json)).toMatchObject({
      ok: true,
      status: "rendered",
    });

    // (c) Now served from the KV overlay, short-circuiting the live handler.
    await gotoGuide(page, f, SLUG);
    await expect(testId(page, "guide-source")).toHaveText("prerender");
    await expect(testId(page, "guide-ondemand")).toHaveText("true");
    await expect(testId(page, "guide-title")).toHaveText(`Guide: ${SLUG}`);
    const overlayRenderedAt = await testId(
      page,
      "guide-rendered-at",
    ).textContent();

    // The overlay payload is frozen: rendered-at is stable across requests.
    await gotoGuide(page, f, SLUG);
    await expect(testId(page, "guide-source")).toHaveText("prerender");
    const overlayRenderedAt2 = await testId(
      page,
      "guide-rendered-at",
    ).textContent();
    expect(overlayRenderedAt2).toBe(overlayRenderedAt);
  });

  test("built slug still serves the build-time prerender", async ({ page }) => {
    using _ = expectNoPageError(page);

    // (d) A slug covered by getParams is prerendered at build time (dev runs the
    // build handler live). guide-source="prerender", not on-demand.
    await gotoGuide(page, f, "routing");
    await expect(testId(page, "guide-source")).toHaveText("prerender");
    await expect(testId(page, "guide-title")).toHaveText("Routing Guide");
    await expect(testId(page, "guide-ondemand")).toHaveText("false");
  });

  test("personalized producer is skipped and live fallback remains", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const slug = `personalized-${SLUG}`;

    await page.goto(f.url(`/guides/personalized/${slug}`));
    await waitForHydration(page);
    await expect(testId(page, "guide-personalized-source")).toHaveText(
      `live:${slug}`,
    );

    const response = await page.request.get(
      f.url(`/guide-personalized-trigger/${slug}`),
    );
    expect(response.ok()).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: "skipped-personalized",
    });

    await page.goto(f.url(`/guides/personalized/${slug}`));
    await waitForHydration(page);
    await expect(testId(page, "guide-personalized-source")).toHaveText(
      `live:${slug}`,
    );
  });
}

async function gotoGuidePlain(
  page: import("@playwright/test").Page,
  f: Fixture,
  slug: string,
) {
  await page.goto(f.url(`/guide-plain/${slug}`));
  await waitForHydration(page);
}

// Shared plain-route flows whose contract is identical in dev and production.
function definePlainOnDemandFlow(f: Fixture) {
  // Trigger the plain route's "intro" entry; qs carries the onlyIfStale/
  // invalidateTag ops.
  const plainTrigger = (page: Page, qs = "") =>
    page.request.get(f.url(`/guide-plain-trigger/intro${qs}`));

  // A trigger response must be { ok: true, status: "rendered" }.
  const expectRendered = (res: APIResponse) =>
    expect(res.json()).resolves.toMatchObject({
      ok: true,
      status: "rendered",
    });

  test("frozen payload with fresh loaders on overlay hit", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Refresh first so the overlay entry (not the baked build entry) serves and
    // the starting state is deterministic across re-runs on a reused server.
    const res = await plainTrigger(page);
    expect(res.ok()).toBe(true);
    await expectRendered(res);

    await gotoGuidePlain(page, f, "intro");
    await expect(testId(page, "gp-source")).toHaveText("prerender");
    await expect(testId(page, "gp-slug")).toHaveText("intro");
    const firstStamp = await testId(page, "gp-stamp").textContent();
    const firstLoader = await testId(page, "gp-loader").textContent();
    expect(firstLoader).toBeTruthy();

    // Second request: the payload is frozen (stamp stable) but the loader is
    // resolved fresh per request (loaders are never pre-rendered).
    await gotoGuidePlain(page, f, "intro");
    await expect(testId(page, "gp-source")).toHaveText("prerender");
    const secondStamp = await testId(page, "gp-stamp").textContent();
    const secondLoader = await testId(page, "gp-loader").textContent();
    expect(secondStamp).toBe(firstStamp);
    expect(secondLoader).not.toBe(firstLoader);
  });

  test("onlyIfStale and KV tag invalidation", async ({ page }) => {
    // Plain refresh always renders.
    const refreshed = await plainTrigger(page);
    await expectRendered(refreshed);

    // Fresh entry + onlyIfStale -> no render.
    const fresh = await plainTrigger(page, "?onlyIfStale=1");
    await expect(fresh.json()).resolves.toMatchObject({
      ok: true,
      status: "already-fresh",
    });

    // KV tag-marker invalidation marks the entry stale without rendering.
    const invalidated = await plainTrigger(
      page,
      `?invalidateTag=${encodeURIComponent("guide-plain:intro")}`,
    );
    await expect(invalidated.json()).resolves.toMatchObject({
      invalidated: "guide-plain:intro",
    });

    // Now stale -> onlyIfStale renders.
    const stale = await plainTrigger(page, "?onlyIfStale=1");
    await expectRendered(stale);
  });

  test("stale overlay hit schedules onRevalidate (swr)", async ({ page }) => {
    // Isolate from prior runs on a reused server (KV persists).
    await page.request.get(f.url(`/guide-swr-trigger/${SWR_SLUG}?swrclear=1`));
    const empty = await page.request.get(
      f.url(`/guide-swr-trigger/${SWR_SLUG}?swrlog=1`),
    );
    await expect(empty.json()).resolves.toMatchObject({ log: null });

    // Populate the overlay (ttl 1s), then let it go stale.
    const refreshed = await page.request.get(
      f.url(`/guide-swr-trigger/${SWR_SLUG}`),
    );
    await expectRendered(refreshed);
    await page.waitForTimeout(1300);

    // The stale overlay entry still serves this request (200)...
    const staleServe = await page.request.get(f.url(`/guide-swr/${SWR_SLUG}`));
    expect(staleServe.status()).toBe(200);
    expect(await staleServe.text()).toContain(SWR_SLUG);

    // ...and schedules onRevalidate via waitUntil (async on workerd) — poll the
    // KV marker the router-level onRevalidate writes.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(
            f.url(`/guide-swr-trigger/${SWR_SLUG}?swrlog=1`),
          );
          const json = (await res.json()) as { log: string | null };
          return json.log;
        },
        { timeout: 8000 },
      )
      .not.toBeNull();
  });
}

test.describe("on-demand prerender (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineOnDemandFlow(f);
  definePlainOnDemandFlow(f);

  test("plain onDemand route: unbaked param 404s until refreshed", async ({
    page,
  }) => {
    // No overlay entry, no baked entry: the retained producer must NOT run
    // live on a production request — DataNotFoundError -> 404 (regression pin
    // for gateOnDemandProducer).
    const miss = await page.request.get(f.url(`/guide-plain/${PLAIN_SLUG}`));
    expect(miss.status()).toBe(404);

    const refreshed = await page.request.get(
      f.url(`/guide-plain-trigger/${PLAIN_SLUG}`),
    );
    await expect(refreshed.json()).resolves.toMatchObject({
      ok: true,
      status: "rendered",
    });

    const hit = await page.request.get(f.url(`/guide-plain/${PLAIN_SLUG}`));
    expect(hit.status()).toBe(200);
    await gotoGuidePlain(page, f, PLAIN_SLUG);
    await expect(testId(page, "gp-source")).toHaveText("prerender");
    await expect(testId(page, "gp-slug")).toHaveText(PLAIN_SLUG);
  });
});

test.describe("on-demand prerender (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineOnDemandFlow(f);
  definePlainOnDemandFlow(f);

  test("plain onDemand route: unbaked param renders live (dev fall-through)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Dev contract: an overlay/manifest miss falls through to a live render.
    const res = await page.request.get(f.url(`/guide-plain/${PLAIN_SLUG}`));
    expect(res.status()).toBe(200);
    await gotoGuidePlain(page, f, PLAIN_SLUG);
    await expect(testId(page, "gp-source")).toHaveText("prerender");
    await expect(testId(page, "gp-slug")).toHaveText(PLAIN_SLUG);
  });
});
