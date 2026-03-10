import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

// -- Dev mode ----------------------------------------------------------------

test.describe("prerender ctx (dev)", () => {
  const f = useFixture({
    root: ".",
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
  });

  test("getParams shared data is not available in dev", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    await expect(testId(page, "prerender-ctx-shared")).toContainText(
      "undefined",
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

test.describe("prerender ctx (production)", () => {
  const f = useFixture({
    root: ".",
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

test.describe("prerender ctx passthrough (production)", () => {
  const f = useFixture({
    root: ".",
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

// -- ctx.passthrough() per-param skip (dev) -----------------------------------
// gamma is in getParams but calls ctx.passthrough() during build. In dev mode
// the route still renders live via on-demand prerender fallback.

test.describe("prerender ctx.passthrough() (dev)", () => {
  const f = useFixture({
    root: ".",
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

// -- ctx.passthrough() per-param skip (production) ----------------------------
// gamma is in getParams but calls ctx.passthrough() during build, so no
// prerender artifact is written. At runtime it renders live like an unknown
// slug, but it was explicitly listed in getParams.

test.describe("prerender ctx.passthrough() (production)", () => {
  const f = useFixture({
    root: ".",
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
