import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  expectNoPageError,
  expectNoReload,
  testId,
  waitForHydration,
} from "./helper";

const INDEX_PATH = "/client-urls-e2e";
const HARD_LOAD_PATH = "/client-urls-e2e/items/hard-load";
const SOFT_NAV_PATH = "/client-urls-e2e/items/soft-nav";
const ORDINARY_SERVER_PATH = "/factory-hmr/alpha";

async function expectItem(
  page: Page,
  itemId: "hard-load" | "soft-nav",
): Promise<void> {
  await expect(testId(page, "client-urls-item")).toBeVisible();
  await expect(testId(page, "client-urls-item-param")).toHaveText(itemId);
  await expect(testId(page, "client-urls-item-loader")).toHaveText(
    `client-urls-item:${itemId}`,
  );
  await expect(testId(page, "client-urls-layout")).toHaveAttribute(
    "data-pending",
    "false",
  );
}

function clientUrlsTests(f: ReturnType<typeof useFixture>): void {
  test("hard load SSRs and hydrates params, loader data, and settled outlet state", async ({
    page,
    request,
  }) => {
    using _ = expectNoPageError(page);

    const response = await request.get(f.url(HARD_LOAD_PATH), {
      headers: { accept: "text/html" },
    });
    const html = await response.text();
    expect(response.ok()).toBe(true);
    expect(html).toContain('data-testid="client-urls-layout"');
    expect(html).toContain('data-pending="false"');
    expect(html).toContain('data-testid="client-urls-item-param"');
    expect(html).toContain("hard-load");
    expect(html).toContain("client-urls-item:hard-load");

    const ordinaryResponse = await request.get(f.url(ORDINARY_SERVER_PATH), {
      headers: { accept: "text/html" },
    });
    const ordinaryHtml = await ordinaryResponse.text();
    expect(ordinaryResponse.ok()).toBe(true);
    expect(ordinaryHtml).toContain('data-testid="factory-alpha"');

    await page.goto(f.url(HARD_LOAD_PATH));
    await waitForHydration(page);
    await expectItem(page, "hard-load");
  });

  test("soft navigation shows local loading and pending state before committing, then Back restores index", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url(INDEX_PATH));
    await waitForHydration(page);
    await expect(testId(page, "client-urls-index")).toBeVisible();
    await expect(testId(page, "client-urls-layout")).toHaveAttribute(
      "data-pending",
      "false",
    );

    await using __ = await expectNoReload(page);
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route(`**${SOFT_NAV_PATH}*`, async (route) => {
      await requestGate;
      await route.continue();
    });
    await testId(page, "client-urls-item-link").click();

    try {
      await Promise.all([
        expect(testId(page, "client-urls-item-loading")).toBeVisible({
          timeout: 500,
        }),
        expect(testId(page, "client-urls-layout")).toHaveAttribute(
          "data-pending",
          "true",
          { timeout: 500 },
        ),
      ]);
    } finally {
      releaseRequest();
    }

    await expectItem(page, "soft-nav");
    await expect(page).toHaveURL(f.url(SOFT_NAV_PATH));

    await page.goBack();
    await expect(page).toHaveURL(f.url(INDEX_PATH));
    await expect(testId(page, "client-urls-index")).toBeVisible();
    await expect(testId(page, "client-urls-layout")).toHaveAttribute(
      "data-pending",
      "false",
    );
  });
}

test.describe("clientUrls vertical slice", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  clientUrlsTests(f);
});

test.describe("clientUrls vertical slice (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  clientUrlsTests(f);
});
