import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Middleware chain integration tests.
 *
 * Verifies the full data flow through:
 *   global middleware -> action -> route middleware -> layout -> handler -> loader -> client component
 *
 * Each layer writes context variables, response headers, and cookies.
 * After a server action, route middleware re-runs (wrapping revalidation)
 * and all layers see fresh state.
 *
 * Also covers:
 *   - Parent loader inheritance: layout loader inherited by path AND parallel
 *   - Orphan layouts: pathless layouts (top-level + nested in path) with parallels
 *   - Handler-first execution: layout ctx.set -> handler ctx.set -> orphan ctx.get
 *     (the wrapping orphan layout reads data from the handler it wraps)
 *   - Intercept chain: global mw -> route mw -> intercept mw -> handler -> loader
 *   - Progressive enhancement: form POST works without JavaScript
 *   - Action within intercept modal: triggers revalidation of modal content
 */
test.describe("Middleware chain (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("initial load: global mw + route mw values propagate to layout, handler, and loaders", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    // Layout sees global and route vars, no action var yet
    await expect(testId(page, "layout-global-var")).toHaveText("from-global");
    await expect(testId(page, "layout-action-var")).toHaveText("none");
    await expect(testId(page, "layout-route-var")).toHaveText("from-route-mw");

    // Handler sees same + reads LayoutData from parent layout
    await expect(testId(page, "handler-global-var")).toHaveText("from-global");
    await expect(testId(page, "handler-action-var")).toHaveText("none");
    await expect(testId(page, "handler-route-var")).toHaveText("from-route-mw");
    await expect(testId(page, "handler-layout-data")).toHaveText(
      "from-main-layout",
    );

    // Handler-first: orphan layout reads LayoutData from main layout
    await expect(testId(page, "orphan-layout-data")).toHaveText(
      "from-main-layout",
    );

    // Handler-first proof: nested orphan reads LayoutData from layout AND
    // HandlerData from the path handler that it wraps in the render tree.
    // The handler runs BEFORE the orphan layout despite being wrapped by it.
    await expect(testId(page, "sub-orphan-layout-data")).toHaveText(
      "from-main-layout",
    );
    await expect(testId(page, "sub-orphan-handler-data")).toHaveText(
      "from-handler",
    );

    // Parallel scoping: variables visible depend on where the parallel lives.
    // @sub-panel (inside path's orphan): sees layout + handler data
    await expect(testId(page, "sub-parallel-layout-data")).toHaveText(
      "from-main-layout",
    );
    await expect(testId(page, "sub-parallel-handler-data")).toHaveText(
      "from-handler",
    );
    // @orphan-panel (inside top-level orphan, sibling to path): sees layout
    // data but NOT handler data (path handler hasn't run in this scope)
    await expect(testId(page, "orphan-parallel-layout-data")).toHaveText(
      "from-main-layout",
    );
    await expect(testId(page, "orphan-parallel-handler-data")).toHaveText(
      "none",
    );
    // @panel (layout-level parallel): handler-first — sees layout data
    // but NOT handler data (path handler runs in a separate entry)
    await expect(testId(page, "parallel-layout-data")).toHaveText(
      "from-main-layout",
    );
    await expect(testId(page, "parallel-handler-data")).toHaveText("none");

    // Loader (via useLoader client component) sees cookies from global + route mw
    await expect(testId(page, "loader-global-cookie")).toHaveText("gv");
    await expect(testId(page, "loader-action-cookie")).toHaveText("none");
    await expect(testId(page, "loader-route-cookie")).toHaveText("rv");

    // Parallel segment: own loader sees same cookies
    await expect(testId(page, "parallel-global-cookie")).toHaveText("gv");
    await expect(testId(page, "parallel-action-cookie")).toHaveText("none");
    await expect(testId(page, "parallel-route-cookie")).toHaveText("rv");

    // Parallel segment: inherited loader from layout also resolves
    await expect(testId(page, "parallel-inherited-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "parallel-inherited-action-cookie")).toHaveText(
      "none",
    );
    await expect(testId(page, "parallel-inherited-route-cookie")).toHaveText(
      "rv",
    );

    // Top-level orphan layout parallel: inherits loader from main layout
    await expect(testId(page, "orphan-inherited-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "orphan-inherited-action-cookie")).toHaveText(
      "none",
    );
    await expect(testId(page, "orphan-inherited-route-cookie")).toHaveText(
      "rv",
    );

    // Nested orphan layout parallel (inside path): inherits loader
    await expect(testId(page, "sub-inherited-global-cookie")).toHaveText("gv");
    await expect(testId(page, "sub-inherited-action-cookie")).toHaveText(
      "none",
    );
    await expect(testId(page, "sub-inherited-route-cookie")).toHaveText("rv");

    // Route middleware report: saw global var, no action cookie
    const report = JSON.parse(
      await testId(page, "handler-route-report").innerText(),
    );
    expect(report.sawGlobalVar).toBe("from-global");
    expect(report.sawActionCookie).toBeNull();
  });

  test("after action: all layers see action-set cookie and vars", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    // Pre-action: no action values
    await expect(testId(page, "handler-action-var")).toHaveText("none");
    await expect(testId(page, "loader-action-cookie")).toHaveText("none");

    // Trigger action
    await testId(page, "chain-action-btn").click();

    // After action revalidation: action var propagates to handler and layout
    await expect(testId(page, "handler-action-var")).toHaveText("from-action", {
      timeout: 10000,
    });
    await expect(testId(page, "layout-action-var")).toHaveText("from-action", {
      timeout: 10000,
    });

    // Loaders see action cookie via read-after-write
    await expect(testId(page, "loader-action-cookie")).toHaveText("av", {
      timeout: 10000,
    });
    await expect(testId(page, "parallel-action-cookie")).toHaveText("av", {
      timeout: 10000,
    });

    // Inherited loader in parallel also sees action cookie
    await expect(testId(page, "parallel-inherited-action-cookie")).toHaveText(
      "av",
      { timeout: 10000 },
    );

    // Top-level orphan parallel sees action cookie
    await expect(testId(page, "orphan-inherited-action-cookie")).toHaveText(
      "av",
      { timeout: 10000 },
    );
    await expect(testId(page, "orphan-inherited-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "orphan-inherited-route-cookie")).toHaveText(
      "rv",
    );

    // Nested orphan parallel (inside path) sees action cookie
    await expect(testId(page, "sub-inherited-action-cookie")).toHaveText("av", {
      timeout: 10000,
    });
    await expect(testId(page, "sub-inherited-global-cookie")).toHaveText("gv");
    await expect(testId(page, "sub-inherited-route-cookie")).toHaveText("rv");

    // Global and route values remain
    await expect(testId(page, "handler-global-var")).toHaveText("from-global");
    await expect(testId(page, "handler-route-var")).toHaveText("from-route-mw");
    await expect(testId(page, "loader-global-cookie")).toHaveText("gv");
    await expect(testId(page, "loader-route-cookie")).toHaveText("rv");

    // Route middleware saw the action cookie during revalidation
    const report = JSON.parse(
      await testId(page, "handler-route-report").innerText(),
    );
    expect(report.sawGlobalVar).toBe("from-global");
    expect(report.sawActionCookie).toBe("av");
  });

  test("response headers include chain headers from all layers", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Intercept the action response to check headers
    const actionResponsePromise = page.waitForResponse((resp) =>
      resp.url().includes("_rsc_action"),
    );

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    await testId(page, "chain-action-btn").click();

    const actionResponse = await actionResponsePromise;
    // Global middleware header
    expect(actionResponse.headers()["x-chain-global"]).toBe("applied");
    // Action header (set via getRequestContext().header())
    expect(actionResponse.headers()["x-chain-action"]).toBe("applied");
    // Route middleware header
    expect(actionResponse.headers()["x-chain-route"]).toBe("applied");
  });

  test("second visit after action: cookies persist across requests", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    // Trigger action to set cookies
    await testId(page, "chain-action-btn").click();
    await expect(testId(page, "loader-action-cookie")).toHaveText("av", {
      timeout: 10000,
    });

    // Reload — all cookies should persist
    await page.reload();
    await waitForHydration(page);

    await expect(testId(page, "loader-global-cookie")).toHaveText("gv");
    await expect(testId(page, "loader-action-cookie")).toHaveText("av");
    await expect(testId(page, "loader-route-cookie")).toHaveText("rv");
    await expect(testId(page, "parallel-global-cookie")).toHaveText("gv");
    await expect(testId(page, "parallel-action-cookie")).toHaveText("av");
    await expect(testId(page, "parallel-route-cookie")).toHaveText("rv");

    // Inherited loader in parallel persists too
    await expect(testId(page, "parallel-inherited-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "parallel-inherited-action-cookie")).toHaveText(
      "av",
    );
    await expect(testId(page, "parallel-inherited-route-cookie")).toHaveText(
      "rv",
    );

    // Top-level orphan parallel persists
    await expect(testId(page, "orphan-inherited-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "orphan-inherited-action-cookie")).toHaveText(
      "av",
    );
    await expect(testId(page, "orphan-inherited-route-cookie")).toHaveText(
      "rv",
    );

    // Nested orphan parallel (inside path) persists
    await expect(testId(page, "sub-inherited-global-cookie")).toHaveText("gv");
    await expect(testId(page, "sub-inherited-action-cookie")).toHaveText("av");
    await expect(testId(page, "sub-inherited-route-cookie")).toHaveText("rv");

    // Route middleware saw the persisted action cookie
    const report = JSON.parse(
      await testId(page, "handler-route-report").innerText(),
    );
    expect(report.sawActionCookie).toBe("av");
  });

  test("intercept: middleware chain propagates through modal", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    // Soft-nav to detail triggers intercept (renders as modal)
    await testId(page, "chain-detail-link").click();
    await expect(testId(page, "mw-chain-modal")).toBeVisible({
      timeout: 10000,
    });

    // Intercept handler sees global mw var
    await expect(testId(page, "intercept-global-var")).toHaveText(
      "from-global",
    );
    // Intercept handler sees route mw var
    await expect(testId(page, "intercept-route-var")).toHaveText(
      "from-route-mw",
    );
    // Intercept handler sees intercept-specific mw var
    await expect(testId(page, "intercept-mw-var")).toHaveText(
      "from-intercept-mw",
    );

    // Intercept loader sees cookies from global + route mw
    await expect(testId(page, "intercept-loader-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "intercept-loader-route-cookie")).toHaveText(
      "rv",
    );
  });

  test("intercept: action within modal triggers revalidation", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    // Open modal via intercept
    await testId(page, "chain-detail-link").click();
    await expect(testId(page, "mw-chain-modal")).toBeVisible({
      timeout: 10000,
    });

    // No action cookie before action
    await expect(testId(page, "intercept-loader-action-cookie")).toHaveText(
      "none",
    );

    // Trigger action from inside the modal
    await testId(page, "modal-action-btn").click();

    // After action: loader in modal sees action cookie
    await expect(testId(page, "intercept-loader-action-cookie")).toHaveText(
      "av",
      { timeout: 10000 },
    );

    // Layout also updated with action var
    await expect(testId(page, "layout-action-var")).toHaveText("from-action", {
      timeout: 10000,
    });
  });

  test("intercept: direct navigation bypasses intercept (full page)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Navigate directly to detail — should render full page, not modal
    await page.goto(f.url("/mw-chain/detail/test-slug"));
    await waitForHydration(page);

    await expect(testId(page, "mw-chain-detail-page")).toBeVisible();
    await expect(testId(page, "detail-slug")).toHaveText("test-slug");

    // Chain vars still propagate through global + route mw
    await expect(testId(page, "detail-global-var")).toHaveText("from-global");
    await expect(testId(page, "detail-route-var")).toHaveText("from-route-mw");

    // Detail page inherits layout loader
    await expect(testId(page, "detail-loader-global-cookie")).toHaveText("gv");
    await expect(testId(page, "detail-loader-route-cookie")).toHaveText("rv");

    // Modal should NOT be present (intercept not triggered on hard nav)
    await expect(testId(page, "mw-chain-modal")).not.toBeVisible();
  });

  test.describe("progressive enhancement", () => {
    test.use({ javaScriptEnabled: false });

    test("PE: returns HTML, not RSC stream", async ({ page }) => {
      await page.goto(f.url("/mw-chain"));
      await expect(testId(page, "mw-chain-page")).toBeVisible();

      await testId(page, "chain-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      const content = await page.content();
      expect(content).toMatch(/<!DOCTYPE html>/i);
      expect(content).not.toMatch(/^0:/);
    });

    test("PE after action: full chain propagation matches JS-enabled behavior", async ({
      page,
    }) => {
      await page.goto(f.url("/mw-chain"));
      await expect(testId(page, "mw-chain-page")).toBeVisible();

      // Submit PE form (native POST, no JS)
      await testId(page, "chain-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      // --- Layout: sees global, action, and route vars ---
      await expect(testId(page, "layout-global-var")).toHaveText("from-global");
      await expect(testId(page, "layout-action-var")).toHaveText("from-action");
      await expect(testId(page, "layout-route-var")).toHaveText(
        "from-route-mw",
      );

      // --- Handler: sees all three var layers + layout data ---
      await expect(testId(page, "handler-global-var")).toHaveText(
        "from-global",
      );
      await expect(testId(page, "handler-action-var")).toHaveText(
        "from-action",
      );
      await expect(testId(page, "handler-route-var")).toHaveText(
        "from-route-mw",
      );
      await expect(testId(page, "handler-layout-data")).toHaveText(
        "from-main-layout",
      );

      // --- Handler-first: orphan layouts read upstream data ---
      await expect(testId(page, "orphan-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "sub-orphan-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "sub-orphan-handler-data")).toHaveText(
        "from-handler",
      );

      // --- Parallel scoping: same rules as JS-enabled ---
      await expect(testId(page, "sub-parallel-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "sub-parallel-handler-data")).toHaveText(
        "from-handler",
      );
      await expect(testId(page, "orphan-parallel-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "orphan-parallel-handler-data")).toHaveText(
        "none",
      );
      await expect(testId(page, "parallel-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "parallel-handler-data")).toHaveText("none");

      // --- Loader (path, via useLoader): sees all cookies ---
      await expect(testId(page, "loader-global-cookie")).toHaveText("gv");
      await expect(testId(page, "loader-action-cookie")).toHaveText("av");
      await expect(testId(page, "loader-route-cookie")).toHaveText("rv");

      // --- Parallel own loader: sees all cookies ---
      await expect(testId(page, "parallel-global-cookie")).toHaveText("gv");
      await expect(testId(page, "parallel-action-cookie")).toHaveText("av");
      await expect(testId(page, "parallel-route-cookie")).toHaveText("rv");

      // --- Parallel inherited loader (from layout): sees all cookies ---
      await expect(testId(page, "parallel-inherited-global-cookie")).toHaveText(
        "gv",
      );
      await expect(testId(page, "parallel-inherited-action-cookie")).toHaveText(
        "av",
      );
      await expect(testId(page, "parallel-inherited-route-cookie")).toHaveText(
        "rv",
      );

      // --- Top-level orphan parallel: inherits loader, sees all cookies ---
      await expect(testId(page, "orphan-inherited-global-cookie")).toHaveText(
        "gv",
      );
      await expect(testId(page, "orphan-inherited-action-cookie")).toHaveText(
        "av",
      );
      await expect(testId(page, "orphan-inherited-route-cookie")).toHaveText(
        "rv",
      );

      // --- Nested orphan parallel (inside path): sees all cookies ---
      await expect(testId(page, "sub-inherited-global-cookie")).toHaveText(
        "gv",
      );
      await expect(testId(page, "sub-inherited-action-cookie")).toHaveText(
        "av",
      );
      await expect(testId(page, "sub-inherited-route-cookie")).toHaveText("rv");

      // --- Route middleware report: observed global var + action cookie ---
      const report = JSON.parse(
        await testId(page, "handler-route-report").innerText(),
      );
      expect(report.sawGlobalVar).toBe("from-global");
      expect(report.sawActionCookie).toBe("av");
    });
  });
});

// === Production mode tests ===

test.describe("Middleware chain (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("initial load: global mw + route mw values propagate (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    await expect(testId(page, "layout-global-var")).toHaveText("from-global");
    await expect(testId(page, "layout-action-var")).toHaveText("none");
    await expect(testId(page, "layout-route-var")).toHaveText("from-route-mw");

    await expect(testId(page, "handler-global-var")).toHaveText("from-global");
    await expect(testId(page, "handler-action-var")).toHaveText("none");
    await expect(testId(page, "handler-route-var")).toHaveText("from-route-mw");
    await expect(testId(page, "handler-layout-data")).toHaveText(
      "from-main-layout",
    );

    // Handler-first: orphan reads layout data, nested orphan reads both
    await expect(testId(page, "orphan-layout-data")).toHaveText(
      "from-main-layout",
    );
    await expect(testId(page, "sub-orphan-layout-data")).toHaveText(
      "from-main-layout",
    );
    await expect(testId(page, "sub-orphan-handler-data")).toHaveText(
      "from-handler",
    );

    // Parallel scoping: same rules as dev
    await expect(testId(page, "sub-parallel-layout-data")).toHaveText(
      "from-main-layout",
    );
    await expect(testId(page, "sub-parallel-handler-data")).toHaveText(
      "from-handler",
    );
    await expect(testId(page, "orphan-parallel-layout-data")).toHaveText(
      "from-main-layout",
    );
    await expect(testId(page, "orphan-parallel-handler-data")).toHaveText(
      "none",
    );
    await expect(testId(page, "parallel-layout-data")).toHaveText(
      "from-main-layout",
    );
    await expect(testId(page, "parallel-handler-data")).toHaveText("none");

    await expect(testId(page, "loader-global-cookie")).toHaveText("gv");
    await expect(testId(page, "loader-action-cookie")).toHaveText("none");
    await expect(testId(page, "loader-route-cookie")).toHaveText("rv");

    await expect(testId(page, "parallel-global-cookie")).toHaveText("gv");
    await expect(testId(page, "parallel-action-cookie")).toHaveText("none");
    await expect(testId(page, "parallel-route-cookie")).toHaveText("rv");

    // Parallel inherits layout loader
    await expect(testId(page, "parallel-inherited-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "parallel-inherited-action-cookie")).toHaveText(
      "none",
    );
    await expect(testId(page, "parallel-inherited-route-cookie")).toHaveText(
      "rv",
    );

    // Top-level orphan parallel
    await expect(testId(page, "orphan-inherited-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "orphan-inherited-action-cookie")).toHaveText(
      "none",
    );
    await expect(testId(page, "orphan-inherited-route-cookie")).toHaveText(
      "rv",
    );

    // Nested orphan parallel (inside path)
    await expect(testId(page, "sub-inherited-global-cookie")).toHaveText("gv");
    await expect(testId(page, "sub-inherited-action-cookie")).toHaveText(
      "none",
    );
    await expect(testId(page, "sub-inherited-route-cookie")).toHaveText("rv");
  });

  test("after action: all layers see action-set cookie and vars (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    await testId(page, "chain-action-btn").click();

    await expect(testId(page, "handler-action-var")).toHaveText("from-action", {
      timeout: 10000,
    });
    await expect(testId(page, "layout-action-var")).toHaveText("from-action", {
      timeout: 10000,
    });

    await expect(testId(page, "loader-action-cookie")).toHaveText("av", {
      timeout: 10000,
    });
    await expect(testId(page, "parallel-action-cookie")).toHaveText("av", {
      timeout: 10000,
    });

    // Inherited loader in parallel
    await expect(testId(page, "parallel-inherited-action-cookie")).toHaveText(
      "av",
      { timeout: 10000 },
    );

    // Top-level orphan parallel
    await expect(testId(page, "orphan-inherited-action-cookie")).toHaveText(
      "av",
      { timeout: 10000 },
    );
    await expect(testId(page, "orphan-inherited-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "orphan-inherited-route-cookie")).toHaveText(
      "rv",
    );

    // Nested orphan parallel (inside path)
    await expect(testId(page, "sub-inherited-action-cookie")).toHaveText("av", {
      timeout: 10000,
    });
    await expect(testId(page, "sub-inherited-global-cookie")).toHaveText("gv");
    await expect(testId(page, "sub-inherited-route-cookie")).toHaveText("rv");

    await expect(testId(page, "handler-global-var")).toHaveText("from-global");
    await expect(testId(page, "handler-route-var")).toHaveText("from-route-mw");
    await expect(testId(page, "loader-global-cookie")).toHaveText("gv");
    await expect(testId(page, "loader-route-cookie")).toHaveText("rv");

    const report = JSON.parse(
      await testId(page, "handler-route-report").innerText(),
    );
    expect(report.sawGlobalVar).toBe("from-global");
    expect(report.sawActionCookie).toBe("av");
  });

  test("response headers include chain headers (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    const actionResponsePromise = page.waitForResponse((resp) =>
      resp.url().includes("_rsc_action"),
    );

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    await testId(page, "chain-action-btn").click();

    const actionResponse = await actionResponsePromise;
    expect(actionResponse.headers()["x-chain-global"]).toBe("applied");
    expect(actionResponse.headers()["x-chain-action"]).toBe("applied");
    expect(actionResponse.headers()["x-chain-route"]).toBe("applied");
  });

  test("second visit after action: cookies persist (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    await testId(page, "chain-action-btn").click();
    await expect(testId(page, "loader-action-cookie")).toHaveText("av", {
      timeout: 10000,
    });

    await page.reload();
    await waitForHydration(page);

    await expect(testId(page, "loader-global-cookie")).toHaveText("gv");
    await expect(testId(page, "loader-action-cookie")).toHaveText("av");
    await expect(testId(page, "loader-route-cookie")).toHaveText("rv");
    await expect(testId(page, "parallel-global-cookie")).toHaveText("gv");
    await expect(testId(page, "parallel-action-cookie")).toHaveText("av");
    await expect(testId(page, "parallel-route-cookie")).toHaveText("rv");
    await expect(testId(page, "parallel-inherited-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "parallel-inherited-action-cookie")).toHaveText(
      "av",
    );
    await expect(testId(page, "parallel-inherited-route-cookie")).toHaveText(
      "rv",
    );

    // Top-level orphan parallel persists
    await expect(testId(page, "orphan-inherited-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "orphan-inherited-action-cookie")).toHaveText(
      "av",
    );
    await expect(testId(page, "orphan-inherited-route-cookie")).toHaveText(
      "rv",
    );

    // Nested orphan parallel (inside path) persists
    await expect(testId(page, "sub-inherited-global-cookie")).toHaveText("gv");
    await expect(testId(page, "sub-inherited-action-cookie")).toHaveText("av");
    await expect(testId(page, "sub-inherited-route-cookie")).toHaveText("rv");
  });

  test("intercept: middleware chain propagates through modal (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    await testId(page, "chain-detail-link").click();
    await expect(testId(page, "mw-chain-modal")).toBeVisible({
      timeout: 10000,
    });

    await expect(testId(page, "intercept-global-var")).toHaveText(
      "from-global",
    );
    await expect(testId(page, "intercept-route-var")).toHaveText(
      "from-route-mw",
    );
    await expect(testId(page, "intercept-mw-var")).toHaveText(
      "from-intercept-mw",
    );

    await expect(testId(page, "intercept-loader-global-cookie")).toHaveText(
      "gv",
    );
    await expect(testId(page, "intercept-loader-route-cookie")).toHaveText(
      "rv",
    );
  });

  test("intercept: action within modal triggers revalidation (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain"));
    await waitForHydration(page);

    await testId(page, "chain-detail-link").click();
    await expect(testId(page, "mw-chain-modal")).toBeVisible({
      timeout: 10000,
    });

    await expect(testId(page, "intercept-loader-action-cookie")).toHaveText(
      "none",
    );

    await testId(page, "modal-action-btn").click();

    await expect(testId(page, "intercept-loader-action-cookie")).toHaveText(
      "av",
      { timeout: 10000 },
    );

    await expect(testId(page, "layout-action-var")).toHaveText("from-action", {
      timeout: 10000,
    });
  });

  test("intercept: direct navigation bypasses intercept (production)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/mw-chain/detail/test-slug"));
    await waitForHydration(page);

    await expect(testId(page, "mw-chain-detail-page")).toBeVisible();
    await expect(testId(page, "detail-slug")).toHaveText("test-slug");

    await expect(testId(page, "detail-global-var")).toHaveText("from-global");
    await expect(testId(page, "detail-route-var")).toHaveText("from-route-mw");

    await expect(testId(page, "detail-loader-global-cookie")).toHaveText("gv");
    await expect(testId(page, "detail-loader-route-cookie")).toHaveText("rv");

    await expect(testId(page, "mw-chain-modal")).not.toBeVisible();
  });

  test.describe("progressive enhancement (production)", () => {
    test.use({ javaScriptEnabled: false });

    test("PE: returns HTML, not RSC stream (production)", async ({ page }) => {
      await page.goto(f.url("/mw-chain"));
      await expect(testId(page, "mw-chain-page")).toBeVisible();

      await testId(page, "chain-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      const content = await page.content();
      expect(content).toMatch(/<!DOCTYPE html>/i);
      expect(content).not.toMatch(/^0:/);
    });

    test("PE after action: full chain propagation matches JS-enabled behavior (production)", async ({
      page,
    }) => {
      await page.goto(f.url("/mw-chain"));
      await expect(testId(page, "mw-chain-page")).toBeVisible();

      await testId(page, "chain-pe-submit").click();
      await page.waitForLoadState("domcontentloaded");

      // --- Layout ---
      await expect(testId(page, "layout-global-var")).toHaveText("from-global");
      await expect(testId(page, "layout-action-var")).toHaveText("from-action");
      await expect(testId(page, "layout-route-var")).toHaveText(
        "from-route-mw",
      );

      // --- Handler ---
      await expect(testId(page, "handler-global-var")).toHaveText(
        "from-global",
      );
      await expect(testId(page, "handler-action-var")).toHaveText(
        "from-action",
      );
      await expect(testId(page, "handler-route-var")).toHaveText(
        "from-route-mw",
      );
      await expect(testId(page, "handler-layout-data")).toHaveText(
        "from-main-layout",
      );

      // --- Handler-first: orphan layouts read upstream data ---
      await expect(testId(page, "orphan-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "sub-orphan-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "sub-orphan-handler-data")).toHaveText(
        "from-handler",
      );

      // --- Parallel scoping: same rules as JS-enabled ---
      await expect(testId(page, "sub-parallel-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "sub-parallel-handler-data")).toHaveText(
        "from-handler",
      );
      await expect(testId(page, "orphan-parallel-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "orphan-parallel-handler-data")).toHaveText(
        "none",
      );
      await expect(testId(page, "parallel-layout-data")).toHaveText(
        "from-main-layout",
      );
      await expect(testId(page, "parallel-handler-data")).toHaveText("none");

      // --- Loader (path) ---
      await expect(testId(page, "loader-global-cookie")).toHaveText("gv");
      await expect(testId(page, "loader-action-cookie")).toHaveText("av");
      await expect(testId(page, "loader-route-cookie")).toHaveText("rv");

      // --- Parallel own loader ---
      await expect(testId(page, "parallel-global-cookie")).toHaveText("gv");
      await expect(testId(page, "parallel-action-cookie")).toHaveText("av");
      await expect(testId(page, "parallel-route-cookie")).toHaveText("rv");

      // --- Parallel inherited loader ---
      await expect(testId(page, "parallel-inherited-global-cookie")).toHaveText(
        "gv",
      );
      await expect(testId(page, "parallel-inherited-action-cookie")).toHaveText(
        "av",
      );
      await expect(testId(page, "parallel-inherited-route-cookie")).toHaveText(
        "rv",
      );

      // --- Top-level orphan parallel ---
      await expect(testId(page, "orphan-inherited-global-cookie")).toHaveText(
        "gv",
      );
      await expect(testId(page, "orphan-inherited-action-cookie")).toHaveText(
        "av",
      );
      await expect(testId(page, "orphan-inherited-route-cookie")).toHaveText(
        "rv",
      );

      // --- Nested orphan parallel (inside path) ---
      await expect(testId(page, "sub-inherited-global-cookie")).toHaveText(
        "gv",
      );
      await expect(testId(page, "sub-inherited-action-cookie")).toHaveText(
        "av",
      );
      await expect(testId(page, "sub-inherited-route-cookie")).toHaveText("rv");

      // --- Route middleware report ---
      const report = JSON.parse(
        await testId(page, "handler-route-report").innerText(),
      );
      expect(report.sawGlobalVar).toBe("from-global");
      expect(report.sawActionCookie).toBe("av");
    });
  });
});
