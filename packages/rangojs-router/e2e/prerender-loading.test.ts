import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Prerender + loading() + ctx.passthrough() (M16 regression guard).
//
// The loading() boundary defers the build handler, so ctx.passthrough() arrives
// Promise-wrapped. detectPrerenderPassthrough must await the thenable before the
// synchronous sentinel check; otherwise the "skip" param bakes a corrupt artifact
// at build time instead of deferring to the live Passthrough handler.
//
// getParams() lists [baked, skip]. "baked" is prerendered; "skip" calls
// ctx.passthrough() and renders live (source === "live", ctx.build === false).

// -- Dev mode ----------------------------------------------------------------
// On-demand dev prerender runs the build handler per request. "baked" renders
// from the build handler (ctx.build true); "skip" falls through to the live
// handler exactly as it does at runtime in production.

test.describe("prerender loading (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("baked slug renders the prerendered build handler", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-loading/baked"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-loading-title")).toHaveText("baked");
    await expect(testId(page, "prerender-loading-source")).toHaveText("baked");
    await expect(testId(page, "prerender-loading-build")).toHaveText("true");
    await expect(testId(page, "prerender-loading-dev")).toHaveText("true");
  });

  test("skip slug passes through to the live handler under loading()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-loading/skip"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-loading-title")).toHaveText("skip");
    // ctx.passthrough() deferred to the live handler despite the loading() boundary.
    await expect(testId(page, "prerender-loading-source")).toHaveText("live");
    await expect(testId(page, "prerender-loading-build")).toHaveText("false");
  });
});

// -- Production build --------------------------------------------------------
// "baked" serves a frozen prerender artifact (stable timestamp). "skip" was
// skipped via ctx.passthrough(), so no artifact exists and it renders live
// (changing timestamp). The manifest holds exactly one entry: baked, not skip.

test.describe("prerender loading (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("baked slug serves a frozen prerender artifact", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-loading/baked"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-loading-title")).toHaveText("baked");
    await expect(testId(page, "prerender-loading-source")).toHaveText("baked");
    await expect(testId(page, "prerender-loading-build")).toHaveText("true");
    await expect(testId(page, "prerender-loading-dev")).toHaveText("false");
  });

  test("baked timestamp is stable across reloads (truly prerendered)", async ({
    page,
  }) => {
    await page.goto(f.url("/prerender-loading/baked"));
    await waitForHydration(page);
    const ts1 = await testId(page, "prerender-loading-ts").textContent();

    await page.reload();
    await waitForHydration(page);
    const ts2 = await testId(page, "prerender-loading-ts").textContent();

    expect(ts1).toBe(ts2);
  });

  test("skip slug renders live via ctx.passthrough() under loading()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-loading/skip"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-loading-title")).toHaveText("skip");
    await expect(testId(page, "prerender-loading-source")).toHaveText("live");
    await expect(testId(page, "prerender-loading-build")).toHaveText("false");
  });

  test("skip timestamp changes across reloads (live, not prerendered)", async ({
    page,
  }) => {
    await page.goto(f.url("/prerender-loading/skip"));
    await waitForHydration(page);
    const ts1 = await testId(page, "prerender-loading-ts").textContent();

    await page.reload();
    await waitForHydration(page);
    const ts2 = await testId(page, "prerender-loading-ts").textContent();

    expect(ts1).not.toBe(ts2);
  });

  test("manifest holds baked but not skip (M16 regression guard)", async ({
    page,
  }) => {
    const res = await page.request.get(
      f.url("/__test/prerender-manifest-entries?route=prerenderLoading.detail"),
    );
    const data = await res.json();
    // Without the fix, "skip" would also be baked (count === 2). With the fix,
    // ctx.passthrough() under loading() defers and only "baked" is prerendered.
    expect(data.available).toBe(true);
    expect(data.count).toBe(1);
  });
});
