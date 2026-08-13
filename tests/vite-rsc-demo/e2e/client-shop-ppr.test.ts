import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { waitForHydration, prodDescribe } from "./helper";

/**
 * ppr on a clientUrls route (/client-shop/ppr/:slug) — the /ssr shape plus a
 * shell declaration, deliberately WITHOUT loading() (loader-container-bake):
 *
 * - MISS document: identical semantics to /ssr — the { ssr: false } loader is
 *   awaited before first flush (data + <head> title in the shell, its skeleton
 *   never SSRs) while the unflagged sidecar streams. Capture runs in the
 *   background.
 * - HIT document: the stored shell carries the baked loader's data AND its
 *   handle pushes — the <title> element and the Meta echo are captured HTML
 *   (the capture awaits flagged loaders since the fresh.ts capture-await fix,
 *   so their pushes beat the capture's barrier snapshot). The sidecar is a
 *   live hole: skeleton in the prelude, fresh value streamed per request.
 *
 * Cookie note: CartLoader re-runs as a live hole on HITs and reads the cart
 * cookie the ensureCartCookie middleware mints. Every test mints it up front
 * with a request to a live route (page.request shares the context cookie jar)
 * so this suite pins the ppr composition, not the middleware-overlay
 * visibility bug tracked separately.
 */

const HTML_HEADERS = { Accept: "text/html" };

async function fetchDoc(page: Page, url: string) {
  const res = await page.request.get(url, { headers: HTML_HEADERS });
  return {
    status: res.status(),
    shell: res.headers()["x-rango-shell"] ?? "",
    body: await res.text(),
  };
}

async function mintCartCookie(page: Page, liveUrl: string): Promise<void> {
  await page.request.get(liveUrl, { headers: HTML_HEADERS });
}

async function warmPprToHit(page: Page, url: string): Promise<void> {
  await expect(async () => {
    const res = await page.request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"] ?? "").toBe("HIT");
  }).toPass({ timeout: 15000 });
}

/** MISS lane = the /ssr document contract on the ppr route (desk-lamp slug). */
function expectPprMissDocument(body: string) {
  expect(body).toContain("Desk Lamp — $39.99");
  expect(body).not.toContain("client-shop-ppr-awaited-skeleton");
  expect(body).toMatch(/<title[^>]*>Desk Lamp — SSR complete<\/title>/);
  expect(body).toContain("client-shop-ppr-sidecar-skeleton");
  expect(body).toContain("streamed sidecar data");
  // Element-heavy read site off the same flagged loader: complete on the
  // MISS lane too — no skeleton, links in the visible document.
  expect(body).not.toContain("client-shop-ppr-complex-skeleton");
  expect(body).toContain("client-shop-ppr-breadcrumbs");
  expect(body).toContain("View product page — $39.99");
}

/** HIT lane: baked data + baked handle pushes in the shell; sidecar live. */
function expectPprHitDocument(body: string) {
  expect(body).toMatch(
    /<title[^>]*>Wireless Headphones — SSR complete<\/title>/,
  );
  expect(body).toContain(
    'data-testid="client-shop-ppr-title">Wireless Headphones — SSR complete<',
  );
  // Baked product data is prelude material — before any late-streamed segment.
  const productAt = body.indexOf("Wireless Headphones — $99.99");
  const firstHidden = body.indexOf("<div hidden");
  expect(productAt).toBeGreaterThan(-1);
  if (firstHidden !== -1) expect(productAt).toBeLessThan(firstHidden);
  expect(body).not.toContain("client-shop-ppr-awaited-skeleton");
  // The baked loader's element-heavy subtree (divs + Links) is shell
  // material: prelude bytes, no skeleton.
  expect(body).not.toContain("client-shop-ppr-complex-skeleton");
  const complexAt = body.indexOf("client-shop-ppr-breadcrumbs");
  expect(complexAt).toBeGreaterThan(-1);
  if (firstHidden !== -1) expect(complexAt).toBeLessThan(firstHidden);
  // The sidecar stays a live hole: skeleton in the prelude, value streamed
  // in the same response.
  expect(body).toContain("client-shop-ppr-sidecar-skeleton");
  expect(body).toContain("streamed sidecar data");
}

devTest.describe("client-shop ppr shell", () => {
  devTest(
    "first document is a MISS with full /ssr semantics",
    async ({ page, devServerURL }) => {
      await mintCartCookie(page, devURL(devServerURL, "/client-shop"));
      const { status, shell, body } = await fetchDoc(
        page,
        devURL(devServerURL, "/client-shop/ppr/desk-lamp"),
      );
      expect(status).toBe(200);
      expect(shell).toBe("MISS");
      expectPprMissDocument(body);
    },
  );

  devTest(
    "HIT serves baked data, baked <head> title, and a live sidecar hole",
    async ({ page, devServerURL }) => {
      await mintCartCookie(page, devURL(devServerURL, "/client-shop"));
      const url = devURL(devServerURL, "/client-shop/ppr/wireless-headphones");
      await warmPprToHit(page, url);
      const { status, shell, body } = await fetchDoc(page, url);
      expect(status).toBe(200);
      expect(shell).toBe("HIT");
      expectPprHitDocument(body);
    },
  );

  devTest(
    "browser HIT hydrates clean: content, echo, and tab title all correct",
    async ({ page, devServerURL }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(devURL(devServerURL, "/client-shop"));
      await waitForHydration(page);
      const url = devURL(devServerURL, "/client-shop/ppr/wireless-headphones");
      await warmPprToHit(page, url);
      await page.goto(url);
      await waitForHydration(page);
      await expect(
        page.locator('[data-testid="client-shop-ppr-name"]'),
      ).toHaveText("Wireless Headphones — $99.99");
      await expect(
        page.locator('[data-testid="client-shop-ppr-sidecar"]'),
      ).toHaveText("streamed sidecar data", { timeout: 10000 });
      await expect(
        page.locator('[data-testid="client-shop-ppr-title"]'),
      ).toHaveText("Wireless Headphones — SSR complete");
      await expect(
        page.locator('[data-testid="client-shop-ppr-complex-link"]'),
      ).toHaveText("View product page — $99.99");
      await expect(page).toHaveTitle("Wireless Headphones — SSR complete");
      expect(errors).toEqual([]);
    },
  );
});

prodDescribe("client-shop ppr shell", (f) => {
  test("first document is a MISS with full /ssr semantics", async ({
    page,
  }) => {
    await mintCartCookie(page, f.url("/client-shop"));
    const { status, shell, body } = await fetchDoc(
      page,
      f.url("/client-shop/ppr/desk-lamp"),
    );
    expect(status).toBe(200);
    expect(shell).toBe("MISS");
    expectPprMissDocument(body);
  });

  test("HIT serves baked data, baked <head> title, and a live sidecar hole", async ({
    page,
  }) => {
    await mintCartCookie(page, f.url("/client-shop"));
    const url = f.url("/client-shop/ppr/wireless-headphones");
    await warmPprToHit(page, url);
    const { status, shell, body } = await fetchDoc(page, url);
    expect(status).toBe(200);
    expect(shell).toBe("HIT");
    expectPprHitDocument(body);
  });

  test("browser HIT hydrates clean: content, echo, and tab title all correct", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(f.url("/client-shop"));
    await waitForHydration(page);
    const url = f.url("/client-shop/ppr/wireless-headphones");
    await warmPprToHit(page, url);
    await page.goto(url);
    await waitForHydration(page);
    await expect(
      page.locator('[data-testid="client-shop-ppr-name"]'),
    ).toHaveText("Wireless Headphones — $99.99");
    await expect(
      page.locator('[data-testid="client-shop-ppr-sidecar"]'),
    ).toHaveText("streamed sidecar data", { timeout: 10000 });
    await expect(
      page.locator('[data-testid="client-shop-ppr-title"]'),
    ).toHaveText("Wireless Headphones — SSR complete");
    await expect(
      page.locator('[data-testid="client-shop-ppr-complex-link"]'),
    ).toHaveText("View product page — $99.99");
    await expect(page).toHaveTitle("Wireless Headphones — SSR complete");
    expect(errors).toEqual([]);
  });
});
