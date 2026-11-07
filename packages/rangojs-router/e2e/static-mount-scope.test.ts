import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

// One Static() layout and slot exported once and mounted under the includes
// "a", "b" and "outer.inner" (test-app/src/urls/static-mounts-urls.tsx): each
// mount links `.settings` in its own module. Dev renders them live; a build
// serves one artifact per mount.

const MOUNTS = [
  { at: "/static-mounts/a", settings: "/static-mounts/a/settings" },
  { at: "/static-mounts/b", settings: "/static-mounts/b/settings" },
  {
    at: "/static-mounts/outer/inner",
    settings: "/static-mounts/outer/inner/settings",
  },
];

async function expectMountLinks(page: Page, settings: string): Promise<void> {
  await expect(
    page.locator('[data-testid="static-mount-nav-link"]'),
  ).toHaveAttribute("href", settings);
  await expect(
    page.locator('[data-testid="static-mount-side-link"]'),
  ).toHaveAttribute("href", settings);
}

function defineCases(f: ReturnType<typeof useFixture>): void {
  for (const { at, settings } of MOUNTS) {
    test(`${at}: the layout and slot link in their own mount`, async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url(`${at}/settings`));
      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="static-mount-settings"]'),
      ).toBeVisible();
      await expectMountLinks(page, settings);
    });
  }

  test("a client navigation from a to b shows b's links", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/static-mounts/a/settings"));
    await waitForHydration(page);
    await expectMountLinks(page, "/static-mounts/a/settings");
    await page.locator('[data-testid="static-mount-to-b"]').click();
    await expect(page).toHaveURL(/\/static-mounts\/b\/settings$/);
    await expectMountLinks(page, "/static-mounts/b/settings");
  });
}

test.describe("static-mount-scope (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  defineCases(f);
});

test.describe("static-mount-scope (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  defineCases(f);
});
