import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

const genFilePath = path.resolve(
  "./e2e/test-app/src/router.named-routes.gen.ts",
);

function devRouteTests(f: ReturnType<typeof useFixture>, mode: "dev" | "prod") {
  if (mode === "dev") {
    test("dev-only route responds with 200 in dev mode", async ({ page }) => {
      using _ = expectNoPageError(page);
      const response = await page.goto(f.url("/__dev/info"));
      expect(response?.status()).toBe(200);
      await expect(page.locator('[data-testid="dev-info-page"]')).toBeVisible();
    });

    test("dev-only included routes respond in dev mode", async ({ page }) => {
      using _ = expectNoPageError(page);
      const response = await page.goto(f.url("/__dev/debug/routes"));
      expect(response?.status()).toBe(200);
      await expect(
        page.locator('[data-testid="debug-routes-page"]'),
      ).toBeVisible();
    });

    test("named-routes output ignores unnamed dev routes in dev mode", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/"));
      await waitForHydration(page);

      await expect(async () => {
        const content = await fs.readFile(genFilePath, "utf-8");
        expect(content).not.toContain("/__dev/info");
        expect(content).not.toContain("/__dev/debug/routes");
        expect(content).not.toContain('"$prefix_');
      }).toPass();
    });
  }

  if (mode === "prod") {
    test("dev-only route returns 404 in production", async ({ page }) => {
      const response = await page.goto(f.url("/__dev/info"));
      expect(response?.status()).toBe(404);
    });

    test("dev-only included routes return 404 in production", async ({
      page,
    }) => {
      const response = await page.goto(f.url("/__dev/debug/routes"));
      expect(response?.status()).toBe(404);
    });

    test("named-routes output ignores unnamed dev routes in production", async () => {
      const content = await fs.readFile(genFilePath, "utf-8");
      expect(content).not.toContain("/__dev/info");
      expect(content).not.toContain("/__dev/debug/routes");
      expect(content).not.toContain('"$prefix_');
    });
  }

  test("non-dev routes still work", async ({ page }) => {
    using _ = expectNoPageError(page);
    const response = await page.goto(f.url("/"));
    expect(response?.status()).toBe(200);
    await waitForHydration(page);
  });
}

test.describe("dev-time routes", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  devRouteTests(f, "dev");
});

test.describe("dev-time routes (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.setTimeout(120000);
  devRouteTests(f, "prod");
});
