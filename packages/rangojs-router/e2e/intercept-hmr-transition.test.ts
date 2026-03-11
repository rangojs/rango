import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  writeFileAndAwaitHmr,
} from "./helper";
import fs from "node:fs";
import path from "node:path";

test.describe.serial("intercept-hmr-transition", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(60000);

  const configPath = path.resolve("./e2e/test-app/src/intercept-hmr-config.ts");
  const configUpdatePattern = /RSC module changed, version updated/;
  let originalContent: string;

  test.beforeAll(async () => {
    originalContent = fs.readFileSync(configPath, "utf-8");
  });

  test.afterAll(async () => {
    fs.writeFileSync(configPath, originalContent);
  });

  test("HMR transitions from intercept to full page when guard changes", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.getByTestId("product-link-product-a").click();
    await expect(page.getByTestId("product-modal")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId("intercept-indicator")).toHaveText(
      "Intercepted",
    );

    const modified = originalContent.replace(
      'return fromPathname === "/";',
      'return fromPathname === "/never-match";',
    );
    await writeFileAndAwaitHmr(page, configPath, modified, {
      totalTimeoutMs: 25000,
      retryIntervalMs: 8000,
      getServerOutput: () => f.proc().stdout(),
      serverOutputPattern: configUpdatePattern,
      waitForApplied: async () => {
        await expect(page.getByTestId("product-detail-page")).toBeVisible({
          timeout: 12000,
        });
      },
    });

    await expect(page.getByTestId("product-detail-page")).toBeVisible();
    await expect(page.getByTestId("product-modal")).not.toBeVisible();
  });
});
