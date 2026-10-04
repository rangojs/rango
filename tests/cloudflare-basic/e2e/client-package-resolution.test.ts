import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

test.describe("client package resolution", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("preserves the deep context in server HTML", async ({ request }) => {
    const response = await request.get(f.url("/client-package-resolution"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);

    const html = await response.text();
    expect(html).toContain("deep-context-value");
    expect(html).not.toContain("NOT_FOUND");
  });

  test("preserves the deep context after hydration", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-package-resolution"));
    await waitForHydration(page);

    await expect(testId(page, "deep-context-value")).toHaveText(
      "deep-context-value",
    );
    await expect(testId(page, "deep-context-value")).not.toHaveText(
      "NOT_FOUND",
    );
  });
});

test.describe("client package resolution (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("preserves the deep context in server HTML", async ({ request }) => {
    const response = await request.get(f.url("/client-package-resolution"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);

    const html = await response.text();
    expect(html).toContain("deep-context-value");
    expect(html).not.toContain("NOT_FOUND");
  });

  test("preserves the deep context after hydration", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/client-package-resolution"));
    await waitForHydration(page);

    await expect(testId(page, "deep-context-value")).toHaveText(
      "deep-context-value",
    );
    await expect(testId(page, "deep-context-value")).not.toHaveText(
      "NOT_FOUND",
    );
  });
});
