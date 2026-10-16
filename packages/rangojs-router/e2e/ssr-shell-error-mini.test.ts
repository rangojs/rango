import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// dc-t93, dc-d150 row 3: a loader read outside Suspense that throws, in the
// mini app, whose only boundary is createRouter({ defaultErrorBoundary }).
// Production answers the recovery document and the browser renders the
// default boundary inside the app root, as a client navigation does; dev keeps
// the host's overlay. Fixture: mini/src/router.tsx /errors/shell-loader.

const PATH = "/errors/shell-loader";

function defineTests(f: Fixture, production: boolean): void {
  test("a document load ends on the router's defaultErrorBoundary", async ({
    page,
  }) => {
    const raw = await page.request.get(f.url(PATH), {
      headers: { Accept: "text/html" },
    });
    const body = await raw.text();

    expect(raw.status()).toBe(500);
    if (!production) {
      expect(body).not.toContain("data-rango-ssr-error");
      expect(body).toContain("/@vite/client");
      expect(body).toContain("mini-shell-loader-error");
      return;
    }
    expect(body).toContain('<html data-rango-ssr-error="">');
    expect(body).not.toContain("file://");
    expect(body).not.toContain("/dist/");

    const response = await page.goto(f.url(PATH));

    expect(response?.status()).toBe(500);
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
    await expect(page.getByTestId("default-client-error")).toBeVisible();
    await expect(page.getByTestId("app-root")).toBeVisible();
  });
}

test.describe("ssr shell error mini", () => {
  const f = useFixture({
    root: "./e2e/mini",
    mode: "dev",
    isolatedServer: true,
  });
  defineTests(f, false);
});

test.describe("ssr shell error mini (production)", () => {
  const f = useFixture({ root: "./e2e/mini", mode: "build" });
  defineTests(f, true);
});
