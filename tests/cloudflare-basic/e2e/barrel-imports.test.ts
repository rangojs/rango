import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

// vite-plugin-react#1519: /barrel-imports imports Button from the
// rango-e2e-barrel-lib barrel, whose calendar.js imports client-only.
// @rolldown/plugin-transform-imports (vite.config.ts) rewrites the import to
// rango-e2e-barrel-lib/button. Discovery's temp server has to apply that
// transform too; without it the production build fails, and in dev every
// request fails with "'client-only' cannot be imported in server build".

async function expectBarrelButton(page: Page, url: string) {
  using _ = expectNoPageError(page);

  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  await waitForHydration(page);

  await expect(testId(page, "barrel-button")).toHaveText("barrel-button-ok");
}

test.describe("barrel imports (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("renders a server component importing from a client-only barrel", async ({
    page,
  }) => {
    await expectBarrelButton(page, f.url("/barrel-imports"));
  });
});

test.describe("barrel imports (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("renders a server component importing from a client-only barrel", async ({
    page,
  }) => {
    await expectBarrelButton(page, f.url("/barrel-imports"));
  });
});
