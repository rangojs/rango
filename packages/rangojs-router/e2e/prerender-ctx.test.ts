import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// -- Dev mode ----------------------------------------------------------------
// In dev mode, Prerender handlers run via on-demand dev prerender.
// ctx.build is true (handler runs in prerender context), getParams does not
// run so shared data is absent, but handler -> child data flow via
// ctx.set()/ctx.get() still works.

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
  });

  test("getParams shared data is not available in dev", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-ctx/alpha"));
    await waitForHydration(page);

    // getParams does not run in dev mode
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
// passthrough: true keeps handler in bundle. Unknown slugs render live.

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
