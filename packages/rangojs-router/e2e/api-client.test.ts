import test, { expect } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError } from "./helper";

const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

function shopUrl(path: string) {
  return f.url(`/api/shop${path}`);
}

async function clearCart(
  request: typeof test extends { request: infer R } ? R : any,
) {
  // Accept the Playwright request context directly
  await (request as any).delete(shopUrl("/cart"));
}

test.describe("shop-api-client", () => {
  // All tests share one in-memory cart on the server, so run sequentially.
  test.describe.configure({ mode: "serial" });
  test.describe("GET requests", () => {
    test("GET /catalog returns product list", async ({ request }) => {
      const res = await request.get(shopUrl("/catalog"));
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toBeDefined();
      expect(body.products).toBeInstanceOf(Array);
      expect(body.products.length).toBeGreaterThan(0);
      expect(body.products[0]).toHaveProperty("id");
      expect(body.products[0]).toHaveProperty("name");
      expect(body.products[0]).toHaveProperty("price");
    });

    test("GET /catalog/:productId returns product", async ({ request }) => {
      const res = await request.get(shopUrl("/catalog/p1"));
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.product).toBeDefined();
      expect(body.product.id).toBe("p1");
      expect(body.product.name).toBe("Widget");
    });

    test("GET /catalog/:productId returns 404 for unknown product", async ({
      request,
    }) => {
      const res = await request.get(shopUrl("/catalog/nonexistent"));
      expect(res.status()).toBe(404);
      const body = await res.json();
      expect(body).toBeDefined();
      expect(body.code).toBe("NOT_FOUND");
      expect(body.detail).toContain("nonexistent");
    });

    test("GET /cart returns empty cart initially", async ({ request }) => {
      await request.delete(shopUrl("/cart"));
      const res = await request.get(shopUrl("/cart"));
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([]);
    });
  });

  test.describe("POST requests", () => {
    test.beforeEach(async ({ request }) => {
      await request.delete(shopUrl("/cart"));
    });

    test("POST /cart adds item and returns cart", async ({ request }) => {
      const res = await request.post(shopUrl("/cart"), {
        data: { productId: "p1", quantity: 2 },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.added).toBeDefined();
      expect(body.added.productId).toBe("p1");
      expect(body.added.quantity).toBe(2);
      expect(body.items.length).toBe(1);
    });

    test("POST /cart with unknown product returns 404", async ({ request }) => {
      const res = await request.post(shopUrl("/cart"), {
        data: { productId: "unknown" },
      });
      expect(res.status()).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NOT_FOUND");
    });
  });

  test.describe("PATCH requests", () => {
    test.beforeEach(async ({ request }) => {
      await request.delete(shopUrl("/cart"));
    });

    test("PATCH /cart/:itemId updates quantity", async ({ request }) => {
      // Add an item first
      const addRes = await request.post(shopUrl("/cart"), {
        data: { productId: "p1", quantity: 1 },
      });
      const addData = await addRes.json();
      const itemId = addData.added.itemId;

      // Patch quantity
      const patchRes = await request.patch(shopUrl(`/cart/${itemId}`), {
        data: { quantity: 5 },
      });
      expect(patchRes.status()).toBe(200);
      const body = await patchRes.json();
      expect(body.item.quantity).toBe(5);
      expect(body.item.itemId).toBe(itemId);
    });

    test("PATCH nonexistent item returns 404", async ({ request }) => {
      const res = await request.patch(shopUrl("/cart/999"), {
        data: { quantity: 5 },
      });
      expect(res.status()).toBe(404);
    });
  });

  test.describe("PUT requests", () => {
    test.beforeEach(async ({ request }) => {
      await request.delete(shopUrl("/cart"));
    });

    test("PUT /cart/:itemId replaces item", async ({ request }) => {
      // Add an item first
      const addRes = await request.post(shopUrl("/cart"), {
        data: { productId: "p1", quantity: 1 },
      });
      const addData = await addRes.json();
      const itemId = addData.added.itemId;

      // Replace with different product
      const putRes = await request.put(shopUrl(`/cart/${itemId}`), {
        data: { productId: "p2", quantity: 3 },
      });
      expect(putRes.status()).toBe(200);
      const body = await putRes.json();
      expect(body.item.productId).toBe("p2");
      expect(body.item.quantity).toBe(3);
      expect(body.item.itemId).toBe(itemId);
    });
  });

  test.describe("DELETE requests", () => {
    test.beforeEach(async ({ request }) => {
      await request.delete(shopUrl("/cart"));
    });

    test("DELETE /cart/:itemId removes item", async ({ request }) => {
      // Add an item
      const addRes = await request.post(shopUrl("/cart"), {
        data: { productId: "p1" },
      });
      const addData = await addRes.json();
      const itemId = addData.added.itemId;

      // Delete it
      const delRes = await request.delete(shopUrl(`/cart/${itemId}`));
      expect(delRes.status()).toBe(200);
      const body = await delRes.json();
      expect(body.deleted).toBe(true);
      expect(body.itemId).toBe(itemId);

      // Verify cart is empty
      const cartRes = await request.get(shopUrl("/cart"));
      const cartBody = await cartRes.json();
      expect(cartBody.items).toEqual([]);
    });

    test("DELETE nonexistent cart item returns 404", async ({ request }) => {
      const res = await request.delete(shopUrl("/cart/nonexistent"));
      expect(res.status()).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NOT_FOUND");
    });

    test("DELETE /cart clears all items", async ({ request }) => {
      // Add some items
      await request.post(shopUrl("/cart"), { data: { productId: "p1" } });
      await request.post(shopUrl("/cart"), { data: { productId: "p2" } });

      // Verify items exist
      const beforeRes = await request.get(shopUrl("/cart"));
      const beforeBody = await beforeRes.json();
      expect(beforeBody.items.length).toBe(2);

      // Clear cart
      const clearRes = await request.delete(shopUrl("/cart"));
      expect(clearRes.status()).toBe(200);
      const clearBody = await clearRes.json();
      expect(clearBody.cleared).toBe(true);

      // Verify empty
      const afterRes = await request.get(shopUrl("/cart"));
      const afterBody = await afterRes.json();
      expect(afterBody.items).toEqual([]);
    });
  });

  test.describe("HEAD requests", () => {
    test("HEAD /health returns 200 with empty body", async ({ request }) => {
      const res = await request.head(shopUrl("/health"));
      expect(res.status()).toBe(200);
      const text = await res.text();
      expect(text).toBe("");
    });
  });

  test.describe("Error handling", () => {
    test("unsupported method returns 405", async ({ request }) => {
      const res = await request.patch(shopUrl("/catalog"), {
        data: {},
      });
      expect(res.status()).toBe(405);
    });

    test("404 for missing resource includes problem details", async ({
      request,
    }) => {
      const res = await request.get(shopUrl("/catalog/does-not-exist"));
      expect(res.status()).toBe(404);
      const body = await res.json();
      expect(body).toBeDefined();
      expect(body.detail).toBeDefined();
      expect(body.code).toBe("NOT_FOUND");
      expect(body.type).toBeUndefined();
      expect(body.title).toBe("Not Found");
      expect(body.status).toBe(404);
    });
  });

  test.describe("GET /health", () => {
    test("returns ok status with timestamp", async ({ request }) => {
      const res = await request.get(shopUrl("/health"));
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeGreaterThan(0);
    });
  });
});

test.describe("shop-playground-ui", () => {
  test("playground page loads and catalog can be loaded", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/shop-playground"));
    await waitForHydration(page);

    // Verify page loaded
    await expect(
      page.locator('[data-testid="playground-title"]'),
    ).toBeVisible();

    // Click load catalog
    await page.click('[data-testid="load-catalog-btn"]');

    // Wait for products to appear
    await expect(page.locator('[data-testid="product-p1"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('[data-testid="product-p2"]')).toBeVisible();
  });

  test("can add item to cart and see it", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/shop-playground"));
    await waitForHydration(page);

    // Clear cart first via API
    await page.request.delete(f.url("/api/shop/cart"));

    // Load catalog
    await page.click('[data-testid="load-catalog-btn"]');
    await expect(page.locator('[data-testid="product-p1"]')).toBeVisible({
      timeout: 5000,
    });

    // Add product to cart
    await page.click('[data-testid="add-to-cart-p1"]');

    // Load cart to see the item
    await page.click('[data-testid="load-cart-btn"]');

    // Wait for cart item to appear
    await expect(page.locator('[data-testid="cart-section"]')).toContainText(
      "1 items",
      { timeout: 5000 },
    );
  });

  test("health check buttons work", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/shop-playground"));
    await waitForHydration(page);

    // HEAD check
    await page.click('[data-testid="health-head-btn"]');
    await expect(page.locator('[data-testid="response-log"]')).toContainText(
      '"ok": true',
      { timeout: 5000 },
    );

    // GET health
    await page.click('[data-testid="health-get-btn"]');
    await expect(page.locator('[data-testid="response-log"]')).toContainText(
      '"status": "ok"',
      { timeout: 5000 },
    );
  });
});
