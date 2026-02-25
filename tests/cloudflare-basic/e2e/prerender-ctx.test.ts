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
