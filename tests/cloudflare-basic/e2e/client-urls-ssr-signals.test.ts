import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

const SIGNALS_PATH = "/client-urls-ssr-signals";

/**
 * workerd mirror of the test-app "ssr:false loader redirect()/notFound()"
 * cases (packages/rangojs-router/e2e/client-urls.test.ts): a { ssr: false }
 * loader settles before the document flush, so its signal is resolved while
 * the server tree is built — a redirect is a 200 document that replaces to
 * the target on hydration, a notFound is a real 404 with the not-found UI.
 * Neither may reach the read site (a throw there 500s the Fizz shell).
 */
function runSsrSignalsSpec(f: Fixture): void {
  test("ssr:false loader redirect(): 200 document then client replace, for layout, page, and child-read readers", async ({
    page,
    request,
  }) => {
    using _ = expectNoPageError(page);

    const variants = ["layout", "page", "child"] as const;
    const responses = await Promise.all(
      variants.map((v) =>
        request.get(f.url(`${SIGNALS_PATH}/${v}`), {
          headers: { accept: "text/html" },
        }),
      ),
    );
    for (const response of responses) expect(response.status()).toBe(200);

    for (const v of variants) {
      await page.goto(f.url(`${SIGNALS_PATH}/${v}`));
      await expect(page).toHaveURL(
        f.url(`/__client-urls?from=ssr-redirect-${v}`),
      );
      await expect(testId(page, "client-urls-layout")).toBeVisible();
    }
  });

  test("ssr:false loader notFound(): real 404 with the not-found UI, no 500", async ({
    page,
    request,
  }) => {
    using _ = expectNoPageError(page);

    const response = await request.get(f.url(`${SIGNALS_PATH}/notfound`), {
      headers: { accept: "text/html" },
    });
    expect(response.status()).toBe(404);
    const html = await response.text();
    expect(html).toContain("<h1>Not Found</h1>");
    expect(html).not.toContain('data-testid="cu-ssr-notfound-page"');

    await page.goto(f.url(`${SIGNALS_PATH}/notfound`));
    await waitForHydration(page);
    await expect(page.locator("h1", { hasText: "Not Found" })).toBeVisible();
    await expect(testId(page, "cu-ssr-notfound-page")).toHaveCount(0);
  });
}

test.describe("clientUrls ssr:false signals", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runSsrSignalsSpec(f);
});

test.describe("clientUrls ssr:false signals (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runSsrSignalsSpec(f);
});
