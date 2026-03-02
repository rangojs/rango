import { expect, test } from "@playwright/test";
import { x } from "tinyexec";
import path from "node:path";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

/**
 * Loader return type tests for the e2e-basic app.
 *
 * Exercises loaders that return ReactNode (JSX) and objects with null values,
 * both cached and non-cached, in dev and production modes.
 */

const E2E_BASIC_ROOT = "./e2e/e2e-basic";

test.beforeAll(async () => {
  const cwd = path.resolve(E2E_BASIC_ROOT);
  await x("pnpm", ["build"], { nodeOptions: { cwd } });
});

// ============================================================================
// Dev mode
// ============================================================================

test.describe("loader-types-basic", () => {
  const f = useFixture({
    root: E2E_BASIC_ROOT,
    mode: "dev",
    isolatedServer: true,
  });

  test("cached ReactNode loader returns serialized JSX on cache hit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-types/react-node-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("react-node-cached-page")).toBeVisible();
    const firstCount = await page.getByTestId("rn-count").textContent();
    const firstTs = await page.getByTestId("rn-ts").textContent();
    expect(firstCount).toBeTruthy();
    expect(firstTs).toBeTruthy();

    await page.waitForTimeout(500);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/loader-types/react-node-cached"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("rn-count").textContent();
    const secondTs = await page.getByTestId("rn-ts").textContent();

    expect(secondCount).toBe(firstCount);
    expect(secondTs).toBe(firstTs);
  });

  test("non-cached ReactNode loader runs fresh on every request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-types/react-node-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("react-node-non-cached-page")).toBeVisible();
    const firstCount = await page.getByTestId("rn-count").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/loader-types/react-node-non-cached"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("rn-count").textContent();

    expect(Number(secondCount)).toBeGreaterThan(Number(firstCount));
  });

  test("cached null-value loader preserves null through cache round-trip", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-types/null-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-cached-page")).toBeVisible();
    await expect(page.getByTestId("null-value")).toHaveText("null");
    const firstCount = await page.getByTestId("null-count").textContent();

    await page.waitForTimeout(500);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/loader-types/null-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-value")).toHaveText("null");
    const secondCount = await page.getByTestId("null-count").textContent();

    expect(secondCount).toBe(firstCount);
  });

  test("non-cached null-value loader runs fresh on every request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-types/null-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-non-cached-page")).toBeVisible();
    await expect(page.getByTestId("null-value")).toHaveText("null");
    const firstCount = await page.getByTestId("null-count").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/loader-types/null-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-value")).toHaveText("null");
    const secondCount = await page.getByTestId("null-count").textContent();

    expect(Number(secondCount)).toBeGreaterThan(Number(firstCount));
  });
});

// ============================================================================
// Production mode
// ============================================================================

test.describe("loader-types-basic (production)", () => {
  const f = useFixture({
    root: E2E_BASIC_ROOT,
    mode: "build",
    buildCommand: "true", // already built at file level
  });

  test("cached ReactNode loader returns serialized JSX on cache hit", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-types/react-node-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("react-node-cached-page")).toBeVisible();
    const firstCount = await page.getByTestId("rn-count").textContent();
    const firstTs = await page.getByTestId("rn-ts").textContent();
    expect(firstCount).toBeTruthy();
    expect(firstTs).toBeTruthy();

    await page.waitForTimeout(500);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/loader-types/react-node-cached"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("rn-count").textContent();
    const secondTs = await page.getByTestId("rn-ts").textContent();

    expect(secondCount).toBe(firstCount);
    expect(secondTs).toBe(firstTs);
  });

  test("non-cached ReactNode loader runs fresh on every request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-types/react-node-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("react-node-non-cached-page")).toBeVisible();
    const firstCount = await page.getByTestId("rn-count").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/loader-types/react-node-non-cached"));
    await waitForHydration(page);

    const secondCount = await page.getByTestId("rn-count").textContent();

    expect(Number(secondCount)).toBeGreaterThan(Number(firstCount));
  });

  test("cached null-value loader preserves null through cache round-trip", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-types/null-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-cached-page")).toBeVisible();
    await expect(page.getByTestId("null-value")).toHaveText("null");
    const firstCount = await page.getByTestId("null-count").textContent();

    await page.waitForTimeout(500);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/loader-types/null-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-value")).toHaveText("null");
    const secondCount = await page.getByTestId("null-count").textContent();

    expect(secondCount).toBe(firstCount);
  });

  test("non-cached null-value loader runs fresh on every request", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/loader-types/null-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-non-cached-page")).toBeVisible();
    await expect(page.getByTestId("null-value")).toHaveText("null");
    const firstCount = await page.getByTestId("null-count").textContent();

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/loader-types/null-non-cached"));
    await waitForHydration(page);

    await expect(page.getByTestId("null-value")).toHaveText("null");
    const secondCount = await page.getByTestId("null-count").textContent();

    expect(Number(secondCount)).toBeGreaterThan(Number(firstCount));
  });
});
