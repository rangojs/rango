import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Tests for colocated createLoader + createHandle + Prerender in the same file.
 *
 * The bug: when a client component directly imports a loader (or handle) from a
 * file that also exports a Prerender() handler, the Vite plugin's non-RSC
 * transform stubs the Prerender call via generateExprStubs and returns early,
 * skipping $$id injection for the colocated loader and handle.
 *
 * This causes useLoader() in the client component to fail because the loader
 * object has no $$id.
 */

// ── Dev mode ─────────────────────────────────────────────────────────────

test.describe("colocated-loader-prerender (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("fresh page renders with colocated loader data via client import", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-lp/fresh"));
    await waitForHydration(page);

    await expect(page.getByTestId("colocated-fresh-title")).toHaveText(
      "Colocated Fresh",
    );

    // Client component should render loader data (useLoader works)
    await expect(page.getByTestId("colocated-client-message")).toHaveText(
      "colocated-loader-data",
    );
  });

  test("loader $$id is injected despite Prerender in same file", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-lp/fresh"));
    await waitForHydration(page);

    const loaderId = await page
      .getByTestId("colocated-loader-id")
      .textContent();
    expect(loaderId).not.toBe("no-loader-id");
    expect(loaderId!.trim()).toBeTruthy();
  });

  test("handle $$id is injected despite Prerender in same file", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-lp/fresh"));
    await waitForHydration(page);

    const handleId = await page
      .getByTestId("colocated-handle-id")
      .textContent();
    expect(handleId).not.toBe("no-handle-id");
    expect(handleId!.trim()).toBeTruthy();
  });

  test("prerender page renders correctly", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-lp/prerender"));
    await waitForHydration(page);

    await expect(page.getByTestId("colocated-prerender-title")).toHaveText(
      "Colocated Prerender",
    );
  });

  test("static page renders correctly (colocated Static handler)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-lp/static"));
    await waitForHydration(page);

    await expect(page.getByTestId("colocated-static-title")).toHaveText(
      "Colocated Static",
    );
  });
});

// ── Production mode ──────────────────────────────────────────────────────

test.describe("colocated-loader-prerender (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("fresh page renders with colocated loader data via client import", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-lp/fresh"));
    await waitForHydration(page);

    await expect(page.getByTestId("colocated-fresh-title")).toHaveText(
      "Colocated Fresh",
    );

    // Client component should render loader data (useLoader works)
    await expect(page.getByTestId("colocated-client-message")).toHaveText(
      "colocated-loader-data",
    );
  });

  test("loader $$id is injected despite Prerender in same file", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-lp/fresh"));
    await waitForHydration(page);

    const loaderId = await page
      .getByTestId("colocated-loader-id")
      .textContent();
    expect(loaderId).not.toBe("no-loader-id");
    expect(loaderId!.trim()).toBeTruthy();
  });

  test("handle $$id is injected despite Prerender in same file", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-lp/fresh"));
    await waitForHydration(page);

    const handleId = await page
      .getByTestId("colocated-handle-id")
      .textContent();
    expect(handleId).not.toBe("no-handle-id");
    expect(handleId!.trim()).toBeTruthy();
  });

  test("prerender page renders correctly", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-lp/prerender"));
    await waitForHydration(page);

    await expect(page.getByTestId("colocated-prerender-title")).toHaveText(
      "Colocated Prerender",
    );
  });

  test("static page renders correctly (colocated Static handler)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-lp/static"));
    await waitForHydration(page);

    await expect(page.getByTestId("colocated-static-title")).toHaveText(
      "Colocated Static",
    );
  });
});
