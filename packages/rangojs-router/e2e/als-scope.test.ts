import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  expectNoPageError,
  testId,
  waitForHydration,
  testNoJs,
} from "./helper";

/**
 * Async context (ALS) propagation tests.
 *
 * Validates three scope contracts:
 *
 * 1. Request scope (router.use) — visible everywhere: global middleware,
 *    route middleware, handlers, layouts, parallels, loaders, intercepts,
 *    and async server components before and after await.
 *
 * 2. Render scope (route middleware) — visible in the render tree for
 *    normal render, PE rerender, and action follow-up revalidation,
 *    but NOT inside the action itself. This is a hard contract boundary.
 *
 * 3. Intercept scope (intercept middleware) — visible only in the
 *    intercept render path, not in direct navigation of the target route.
 */

function alsScopeTests(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : mode;

  test.describe(`als-scope (${label})`, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    // ========================================================================
    // Request scope: visible to all probe points on initial render
    // ========================================================================

    test("handler sees request scope [global] and render scope [route]", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      await expect(testId(page, "als-handler-scope")).toHaveText(
        "global,route",
      );
      await expect(testId(page, "als-handler-request-id")).not.toHaveText(
        "none",
      );
    });

    test("layout sees request scope [global] and render scope [route]", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      await expect(testId(page, "als-layout-scope")).toHaveText("global,route");
      await expect(testId(page, "als-layout-request-id")).not.toHaveText(
        "none",
      );
    });

    test("parallel slot sees request scope and render scope", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      await expect(testId(page, "als-parallel-scope")).toHaveText(
        "global,route",
      );
      await expect(testId(page, "als-parallel-request-id")).not.toHaveText(
        "none",
      );
    });

    test("orphan layout sees request scope and render scope", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      await expect(testId(page, "als-orphan-scope")).toHaveText("global,route");
      await expect(testId(page, "als-orphan-request-id")).not.toHaveText(
        "none",
      );
    });

    test("loader sees request scope and render scope via getRequestContext()", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      // Loader data is rendered in the layout via the AlsScopeLoader
      await expect(testId(page, "als-loader-scope")).toHaveText("global,route");
      await expect(testId(page, "als-loader-request-id")).not.toHaveText(
        "none",
      );
    });

    test("async server component reads ALS after await", async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      await expect(testId(page, "als-async-scope")).toHaveText("global,route");
      await expect(testId(page, "als-async-request-id")).not.toHaveText("none");
    });

    test("streamed component behind loading() reads ALS after delay", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      // Streamed probe appears after ~500ms delay
      await expect(testId(page, "als-streamed-scope")).toHaveText(
        "global,route",
        { timeout: 10000 },
      );
      await expect(testId(page, "als-streamed-request-id")).not.toHaveText(
        "none",
      );
    });

    test("all probes share the same request ID within a single request", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      // Wait for streamed probe to appear
      await expect(testId(page, "als-streamed-request-id")).not.toHaveText(
        "none",
        { timeout: 10000 },
      );

      const handlerId = await testId(
        page,
        "als-handler-request-id",
      ).textContent();
      const layoutId = await testId(
        page,
        "als-layout-request-id",
      ).textContent();
      const parallelId = await testId(
        page,
        "als-parallel-request-id",
      ).textContent();
      const orphanId = await testId(
        page,
        "als-orphan-request-id",
      ).textContent();
      const loaderId = await testId(
        page,
        "als-loader-request-id",
      ).textContent();
      const asyncId = await testId(page, "als-async-request-id").textContent();
      const streamedId = await testId(
        page,
        "als-streamed-request-id",
      ).textContent();

      expect(handlerId).not.toBe("none");
      expect(layoutId).toBe(handlerId);
      expect(parallelId).toBe(handlerId);
      expect(orphanId).toBe(handlerId);
      expect(loaderId).toBe(handlerId);
      expect(asyncId).toBe(handlerId);
      expect(streamedId).toBe(handlerId);
    });

    // ========================================================================
    // Action scope: route middleware does NOT wrap action execution
    // ========================================================================

    test("JS action sees only request scope [global], not render scope [route]", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      // Before action: probe shows "none"
      await expect(testId(page, "als-action-probe")).toHaveText("none");

      // Run action
      await testId(page, "als-action-btn").click();

      // After action: probe shows what the action saw.
      // Route middleware does NOT wrap action execution, so the action
      // should see only ["global"] — not ["global", "route"].
      await expect(testId(page, "als-action-probe")).toHaveText("global", {
        timeout: 10000,
      });
    });

    test("post-action revalidation render sees full scope [global,route]", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      await testId(page, "als-action-btn").click();

      // After action: revalidation is wrapped by route middleware,
      // so the handler sees the full scope.
      await expect(testId(page, "als-handler-scope")).toHaveText(
        "global,route",
        { timeout: 10000 },
      );
    });

    // ========================================================================
    // PE action scope: same contract as JS
    // ========================================================================

    test.describe("PE transport", () => {
      test.use({ javaScriptEnabled: false });

      test("PE action sees only request scope [global], not render scope [route]", async ({
        page,
      }) => {
        await page.goto(f.url("/als-scope"));
        // With JS disabled, wait for layout (above loading boundary) to appear
        await expect(testId(page, "als-layout")).toBeVisible();

        // Run PE action
        await testId(page, "als-pe-submit").click();
        await page.waitForLoadState("load");

        // The PE rerender is a full render wrapped by route middleware,
        // but the action itself ran outside route middleware scope.
        // Use textContent() since the handler output may be behind a
        // Suspense boundary that is not revealed without JS.
        const actionProbe = await testId(page, "als-action-probe").textContent({
          timeout: 10000,
        });
        expect(actionProbe).toBe("global");

        const handlerScope = await testId(
          page,
          "als-handler-scope",
        ).textContent({ timeout: 10000 });
        expect(handlerScope).toBe("global,route");
      });
    });

    // ========================================================================
    // Intercept scope: intercept middleware only visible in intercept render
    // ========================================================================

    test("intercept handler sees intercept scope [global,route,intercept]", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope"));
      await waitForHydration(page);

      // Click detail link to trigger intercept
      await testId(page, "als-detail-link").click();
      await expect(testId(page, "als-modal")).toBeVisible({ timeout: 10000 });

      await expect(testId(page, "als-intercept-scope")).toHaveText(
        "global,route,intercept",
      );
      await expect(testId(page, "als-intercept-request-id")).not.toHaveText(
        "none",
      );
    });

    test("direct navigation to intercept target does NOT see intercept scope", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/als-scope/detail/test-slug"));
      await waitForHydration(page);

      // Direct navigation — no intercept middleware runs
      await expect(testId(page, "als-detail-scope")).toHaveText("global,route");
      await expect(testId(page, "als-modal")).not.toBeVisible();
    });

    // ========================================================================
    // Concurrent isolation: two simultaneous requests get different IDs
    // ========================================================================

    test("concurrent requests have isolated ALS contexts", async ({
      context,
    }) => {
      // Fire two requests in parallel and verify they get different request IDs
      const [page1, page2] = await Promise.all([
        context.newPage(),
        context.newPage(),
      ]);

      await Promise.all([
        page1.goto(f.url("/als-scope")),
        page2.goto(f.url("/als-scope")),
      ]);

      await Promise.all([waitForHydration(page1), waitForHydration(page2)]);

      const id1 = await testId(page1, "als-handler-request-id").textContent();
      const id2 = await testId(page2, "als-handler-request-id").textContent();

      expect(id1).not.toBe("none");
      expect(id2).not.toBe("none");
      expect(id1).not.toBe(id2);

      await page1.close();
      await page2.close();
    });
  });
}

alsScopeTests("dev");
alsScopeTests("build");
