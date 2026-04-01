import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// -- Dev mode ----------------------------------------------------------------
// In dev mode, Prerender handlers run via on-demand dev prerender.
// ctx.build is true (handler runs in prerender context), ctx.dev is true.
// For passthrough routes, getParams() runs to check known params; its
// ctx.set() values are carried into the render context. Handler -> child
// data flow via ctx.set()/ctx.get() still works.

test.describe("prerender ctx (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("handler renders with correct slug", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-title")).toContainText("alpha");
  });

  test("ctx.build is true in dev prerender", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-build")).toContainText("true");
    await expect(testId(page, "prerender-ctx-dev")).toHaveText("true");
  });

  test("getParams shared data is available in dev (passthrough route runs getParams)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    // getParams runs in dev mode for passthrough routes to check known params.
    // Its ctx.set() values are carried forward to the render context.
    await expect(testId(page, "prerender-ctx-shared")).toContainText(
      "fetched-at-build",
    );
  });

  test("layout sees handler ctx.set() data via ctx.get()", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-layout-data")).toContainText(
      "data-for-alpha",
    );
  });

  test("parallel sees handler ctx.set() data via ctx.get()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-sidebar-data")).toContainText(
      "data-for-alpha",
    );
  });
});

// -- Production build --------------------------------------------------------
// In production, pre-rendered slugs serve frozen build-time content.
// ctx.build is true, getParams shared data is available.

test.describe("prerender ctx (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("pre-rendered slug renders correct content", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-title")).toContainText("alpha");
  });

  test("ctx.build is true for pre-rendered content", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-build")).toContainText("true");
    await expect(testId(page, "prerender-ctx-dev")).toHaveText("false");
  });

  test("getParams shared data is available in pre-rendered content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-shared")).toContainText(
      "fetched-at-build",
    );
  });

  test("layout has correct handler data in pre-rendered content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-layout-data")).toContainText(
      "data-for-alpha",
    );
  });

  test("parallel has correct handler data in pre-rendered content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-sidebar-data")).toContainText(
      "data-for-alpha",
    );
  });

  test("pre-rendered timestamps are stable across reloads", async ({
    page,
  }) => {
    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    const ts1 = await testId(page, "prerender-ctx-timestamp").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "prerender-ctx-timestamp").textContent();

    // Truly pre-rendered: identical timestamp across reloads
    expect(ts1).toBe(ts2);
  });

  test("second pre-rendered slug also has correct data", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/beta"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-title")).toContainText("beta");
    await expect(testId(page, "prerender-ctx-layout-data")).toContainText(
      "data-for-beta",
    );
    await expect(testId(page, "prerender-ctx-sidebar-data")).toContainText(
      "data-for-beta",
    );
  });
});

// -- Passthrough (unknown slug, live render) ---------------------------------
// Passthrough() wraps the Prerender def with a live handler. Unknown slugs render live.

test.describe("prerender ctx passthrough (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("unknown slug renders live via passthrough", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/unknown-slug"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-title")).toContainText(
      "unknown-slug",
    );
  });

  test("ctx.build is false for passthrough live render", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/unknown-slug"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-build")).toContainText("false");
    await expect(testId(page, "prerender-ctx-dev")).toHaveText("false");
  });

  test("layout gets handler data in passthrough live render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/unknown-slug"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-layout-data")).toContainText(
      "data-for-unknown-slug",
    );
  });

  test("parallel gets handler data in passthrough live render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/unknown-slug"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-sidebar-data")).toContainText(
      "data-for-unknown-slug",
    );
  });
});

// -- ctx.passthrough() per-param skip (dev mode) ------------------------------
// gamma is in getParams but calls ctx.passthrough() during build. In dev mode
// the route still renders live via on-demand prerender fallback.

test.describe("prerender ctx.passthrough() (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("gamma renders live in dev despite ctx.passthrough()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/gamma"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-title")).toContainText("gamma");
  });

  test("gamma ctx.build is false (passthrough fell through to live)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/gamma"));
    await waitForHydration(page);

    // On-demand prerender returned passthrough, so handler reruns live
    await expect(testId(page, "prerender-ctx-build")).toContainText("false");
    await expect(testId(page, "prerender-ctx-dev")).toHaveText("false");
  });

  test("gamma layout has correct handler data in dev", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/gamma"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-layout-data")).toContainText(
      "data-for-gamma",
    );
  });

  test("gamma parallel has correct handler data in dev", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/gamma"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-sidebar-data")).toContainText(
      "data-for-gamma",
    );
  });
});

// -- ctx.passthrough() per-param skip (production build) ----------------------
// gamma is in getParams but calls ctx.passthrough() during build, so no
// prerender artifact is written. At runtime it renders live like an unknown
// slug, but it was explicitly listed in getParams.

test.describe("prerender ctx.passthrough() (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("gamma renders live via ctx.passthrough() skip", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/gamma"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-title")).toContainText("gamma");
  });

  test("gamma has ctx.build === false (live render, not cached)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/gamma"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-build")).toContainText("false");
    await expect(testId(page, "prerender-ctx-dev")).toHaveText("false");
  });

  test("gamma timestamp changes across reloads (not prerendered)", async ({
    page,
  }) => {
    await page.goto(f.url("/prerender-ctx/gamma"));
    await waitForHydration(page);

    const ts1 = await testId(page, "prerender-ctx-timestamp").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "prerender-ctx-timestamp").textContent();

    // Live render: timestamp should change (unlike pre-rendered alpha/beta)
    expect(ts1).not.toBe(ts2);
  });

  test("gamma layout has correct handler data", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/gamma"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-layout-data")).toContainText(
      "data-for-gamma",
    );
  });

  test("gamma parallel has correct handler data", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/gamma"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-sidebar-data")).toContainText(
      "data-for-gamma",
    );
  });

  test("manifest has alpha and beta but not gamma", async ({ page }) => {
    const res = await page.request.get(
      f.url("/__test/prerender-manifest-entries?route=prerenderCtx.detail"),
    );
    const json = await res.json();
    // path.json() wraps in { data: ... } envelope
    const data = json.data;
    // getParams returns [alpha, beta, gamma], but gamma called ctx.passthrough()
    // so only alpha + beta should have prerender manifest entries.
    expect(data.available).toBe(true);
    expect(data.count).toBe(2);
  });

  test("alpha is still prerendered (stable timestamp)", async ({ page }) => {
    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    const ts1 = await testId(page, "prerender-ctx-timestamp").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "prerender-ctx-timestamp").textContent();

    // Pre-rendered: identical timestamp across reloads
    expect(ts1).toBe(ts2);
  });
});
