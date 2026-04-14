import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

// -- Dev mode ----------------------------------------------------------------

test.describe("handler.use (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("handler.use provides loader data", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-use"));
    await waitForHydration(page);

    await expect(page.getByTestId("handler-use-title")).toHaveText(
      "Handler Use Test",
    );
    await expect(page.getByTestId("handler-use-data")).toHaveText(
      "from-handler-use-loader",
    );
  });

  test("handler.use middleware sets response header", async ({ page }) => {
    using _ = expectNoPageError(page);

    const response = await page.goto(f.url("/handler-use"));
    await waitForHydration(page);

    expect(response?.headers()["x-handler-use-default"]).toBe("applied");
  });

  test("layout handler.use middleware sets response header", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const response = await page.goto(f.url("/handler-use"));
    await waitForHydration(page);

    expect(response?.headers()["x-handler-use-layout"]).toBe("applied");
  });

  test("layout handler.use middleware sets context variable", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-use"));
    await waitForHydration(page);

    await expect(page.getByTestId("layout-mw-value")).toHaveText(
      "Layout MW: from-layout-use",
    );
  });

  test("handler.use + explicit use both apply (merge)", async ({ page }) => {
    using _ = expectNoPageError(page);

    const response = await page.goto(f.url("/handler-use/merged"));
    await waitForHydration(page);

    // handler.use middleware header
    expect(response?.headers()["x-handler-use-default"]).toBe("applied");
    // explicit use middleware header
    expect(response?.headers()["x-explicit-use"]).toBe("applied");
    // loader data from handler.use
    await expect(page.getByTestId("merged-data")).toHaveText(
      "from-handler-use-loader",
    );
  });

  test("parallel slots each render their own handler.use loader data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-use/parallel"));
    await waitForHydration(page);

    await expect(page.getByTestId("parallel-title")).toHaveText(
      "Parallel Slot Use Test",
    );
    // Each slot renders its own loader data — no cross-slot bleed
    await expect(page.getByTestId("sidebar-section")).toHaveText(
      "sidebar-data",
    );
    await expect(page.getByTestId("panel-section")).toHaveText("panel-data");
  });

  test("parallel slot handler.use + explicit use compose correctly", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-use/parallel-override"));
    await waitForHydration(page);

    await expect(page.getByTestId("parallel-override-title")).toHaveText(
      "Parallel Override Use Test",
    );
    // Slot handler.use loader still works alongside explicit use
    await expect(page.getByTestId("override-sidebar-section")).toHaveText(
      "slow-sidebar-data",
    );
  });

  test("explicit loading() overrides handler.use loading() on parallel slot", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start on the index page (same layout, different route)
    await page.goto(f.url("/handler-use"));
    await waitForHydration(page);

    // Client-side navigate to the override route. The slow loader (300ms)
    // triggers the loading state. handler.use provides loading(<ThrowingLoading />)
    // but explicit use provides loading(<div>Loading sidebar...</div>).
    // If the override order is wrong, ThrowingLoading renders and the
    // expectNoPageError guard catches the error.
    await page.getByTestId("link-to-override").click();

    // The explicit loading text should appear while the slow loader resolves
    await expect(page.getByTestId("override-loading")).toBeVisible();

    // After the loader resolves, the real content appears
    await expect(page.getByTestId("override-sidebar-section")).toHaveText(
      "slow-sidebar-data",
    );
  });

  test("explicit parallel() overrides handler.use parallel() for same slot", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // handler.use provides parallel(@sidebar: ThrowingSidebar).
    // Explicit use provides parallel(@sidebar: RealSidebar).
    // If handler.use's ThrowingSidebar survives, the page errors out.
    await page.goto(f.url("/handler-use/parallel-slot-override"));
    await waitForHydration(page);

    await expect(page.getByTestId("slot-override-title")).toHaveText(
      "Parallel Slot Override Test",
    );
    await expect(page.getByTestId("real-sidebar-text")).toHaveText(
      "real-sidebar-content",
    );
  });

  test("slot descriptor: per-slot loading() renders both slots end-to-end", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // The slot-local loading() mechanism is verified at the entry level by
    // handler-use-integration.test.tsx (entry.loading is set on @sidebar and
    // undefined on @panel). The e2e's job is to confirm the runtime accepts
    // the slot descriptor form and renders both slots without crashing.
    // Asserting the transient skeleton is flaky on fast CI because the
    // Suspense fallback → content transition can complete below Playwright's
    // polling window.
    await page.goto(f.url("/handler-use"));
    await waitForHydration(page);
    await page.getByTestId("link-to-slot-descriptor").click();

    await expect(page.getByTestId("descriptor-sidebar-section")).toHaveText(
      "slow-sidebar-data",
    );
    await expect(page.getByTestId("descriptor-panel-section")).toHaveText(
      "slow-panel-data",
    );
  });

  test("slot descriptor: loading(false) opts one slot out and both slots still render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Unit tests prove @sidebar gets loading=false and @panel gets the
    // broadcast skeleton. The e2e verifies the runtime handles the opt-out
    // shape and both slots render their data.
    await page.goto(f.url("/handler-use"));
    await waitForHydration(page);
    await page.getByTestId("link-to-slot-opt-out").click();

    await expect(page.getByTestId("descriptor-sidebar-section")).toHaveText(
      "slow-sidebar-data",
    );
    await expect(page.getByTestId("descriptor-panel-section")).toHaveText(
      "slow-panel-data",
    );
  });
});

// -- Production build --------------------------------------------------------

test.describe("handler.use (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("handler.use provides loader data", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-use"));
    await waitForHydration(page);

    await expect(page.getByTestId("handler-use-title")).toHaveText(
      "Handler Use Test",
    );
    await expect(page.getByTestId("handler-use-data")).toHaveText(
      "from-handler-use-loader",
    );
  });

  test("handler.use middleware sets response header", async ({ page }) => {
    using _ = expectNoPageError(page);

    const response = await page.goto(f.url("/handler-use"));
    await waitForHydration(page);

    expect(response?.headers()["x-handler-use-default"]).toBe("applied");
  });

  test("layout handler.use middleware sets response header", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const response = await page.goto(f.url("/handler-use"));
    await waitForHydration(page);

    expect(response?.headers()["x-handler-use-layout"]).toBe("applied");
  });

  test("layout handler.use middleware sets context variable", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-use"));
    await waitForHydration(page);

    await expect(page.getByTestId("layout-mw-value")).toHaveText(
      "Layout MW: from-layout-use",
    );
  });

  test("handler.use + explicit use both apply (merge)", async ({ page }) => {
    using _ = expectNoPageError(page);

    const response = await page.goto(f.url("/handler-use/merged"));
    await waitForHydration(page);

    // handler.use middleware header
    expect(response?.headers()["x-handler-use-default"]).toBe("applied");
    // explicit use middleware header
    expect(response?.headers()["x-explicit-use"]).toBe("applied");
    // loader data from handler.use
    await expect(page.getByTestId("merged-data")).toHaveText(
      "from-handler-use-loader",
    );
  });

  test("parallel slots each render their own handler.use loader data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-use/parallel"));
    await waitForHydration(page);

    await expect(page.getByTestId("parallel-title")).toHaveText(
      "Parallel Slot Use Test",
    );
    // Each slot renders its own loader data — no cross-slot bleed
    await expect(page.getByTestId("sidebar-section")).toHaveText(
      "sidebar-data",
    );
    await expect(page.getByTestId("panel-section")).toHaveText("panel-data");
  });

  test("parallel slot handler.use + explicit use compose correctly", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-use/parallel-override"));
    await waitForHydration(page);

    await expect(page.getByTestId("parallel-override-title")).toHaveText(
      "Parallel Override Use Test",
    );
    // Slot handler.use loader still works alongside explicit use
    await expect(page.getByTestId("override-sidebar-section")).toHaveText(
      "slow-sidebar-data",
    );
  });

  test("explicit loading() overrides handler.use loading() on parallel slot", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start on the index page (same layout, different route)
    await page.goto(f.url("/handler-use"));
    await waitForHydration(page);

    // Client-side navigate to the override route. The slow loader (300ms)
    // triggers the loading state. handler.use provides loading(<ThrowingLoading />)
    // but explicit use provides loading(<div>Loading sidebar...</div>).
    // If the override order is wrong, ThrowingLoading renders and the
    // expectNoPageError guard catches the error.
    await page.getByTestId("link-to-override").click();

    // The explicit loading text should appear while the slow loader resolves
    await expect(page.getByTestId("override-loading")).toBeVisible();

    // After the loader resolves, the real content appears
    await expect(page.getByTestId("override-sidebar-section")).toHaveText(
      "slow-sidebar-data",
    );
  });

  test("explicit parallel() overrides handler.use parallel() for same slot", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-use/parallel-slot-override"));
    await waitForHydration(page);

    await expect(page.getByTestId("slot-override-title")).toHaveText(
      "Parallel Slot Override Test",
    );
    await expect(page.getByTestId("real-sidebar-text")).toHaveText(
      "real-sidebar-content",
    );
  });

  test("slot descriptor: per-slot loading() renders both slots end-to-end", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Mechanism verified by integration tests at the entry level; e2e just
    // confirms the runtime accepts the slot descriptor and renders both
    // slots without crashing. (Transient skeleton assertions are flaky on
    // fast CI because the Suspense fallback → content transition can
    // complete below Playwright's polling window.)
    await page.goto(f.url("/handler-use"));
    await waitForHydration(page);
    await page.getByTestId("link-to-slot-descriptor").click();

    await expect(page.getByTestId("descriptor-sidebar-section")).toHaveText(
      "slow-sidebar-data",
    );
    await expect(page.getByTestId("descriptor-panel-section")).toHaveText(
      "slow-panel-data",
    );
  });

  test("slot descriptor: loading(false) opts one slot out and both slots still render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/handler-use"));
    await waitForHydration(page);
    await page.getByTestId("link-to-slot-opt-out").click();

    await expect(page.getByTestId("descriptor-sidebar-section")).toHaveText(
      "slow-sidebar-data",
    );
    await expect(page.getByTestId("descriptor-panel-section")).toHaveText(
      "slow-panel-data",
    );
  });
});
