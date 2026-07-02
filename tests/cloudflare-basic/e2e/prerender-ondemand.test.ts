import { expect, test } from "@playwright/test";
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
const SLUG = `ondemand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
    expect(json).toMatchObject({ ok: true, status: "rendered" });

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
}

test.describe("on-demand prerender (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineOnDemandFlow(f);
});

test.describe("on-demand prerender (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineOnDemandFlow(f);
});
