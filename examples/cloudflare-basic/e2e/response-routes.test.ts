import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
} from "./helper";

test.describe.configure({ mode: "serial" });

test.describe("response routes", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("GET /api/health returns JSON with status ok", async ({ request }) => {
    const response = await request.get(f.url("/api/health"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  test("GET /api/products returns JSON array", async ({ request }) => {
    const response = await request.get(f.url("/api/products"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(3);
    expect(body[0].name).toBe("Widget");
  });

  test("GET /api/products/:id returns JSON with params", async ({ request }) => {
    const response = await request.get(f.url("/api/products/42"));
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.id).toBe("42");
    expect(body.name).toBe("Product 42");
  });

  test("GET /robots.txt returns plain text", async ({ request }) => {
    const response = await request.get(f.url("/robots.txt"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /api/");
  });

  test("response route does not return RSC Flight payload", async ({ request }) => {
    // Direct GET without RSC headers should return raw JSON, not Flight
    const response = await request.get(f.url("/api/health"));
    const contentType = response.headers()["content-type"] || "";
    expect(contentType).not.toContain("text/x-component");
    expect(contentType).toContain("application/json");
  });

  test("client navigation to response route triggers hard navigation", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    // The API Health link has data-external, which triggers hard navigation
    const apiLink = testId(page, "nav-api");
    await expect(apiLink).toBeVisible();

    // Verify the link has data-external attribute
    const dataExternal = await apiLink.getAttribute("data-external");
    expect(dataExternal).toBe("");
  });

  test("partial request to response route returns X-RSC-Reload", async ({ request }) => {
    // Simulate a partial RSC request to a response route
    const response = await request.get(f.url("/api/health?_rsc_partial=1"), {
      headers: {
        "X-RSC-Router-Client-Path": "/",
      },
    });

    // Should get X-RSC-Reload header signaling hard navigation
    const reloadHeader = response.headers()["x-rsc-reload"];
    expect(reloadHeader).toBeTruthy();
    expect(reloadHeader).toContain("/api/health");
    // Should not contain RSC query params
    expect(reloadHeader).not.toContain("_rsc_partial");
  });
});

test.describe("response routes (build)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("GET /api/health returns JSON in production build", async ({ request }) => {
    const response = await request.get(f.url("/api/health"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  test("GET /robots.txt returns plain text in production build", async ({ request }) => {
    const response = await request.get(f.url("/robots.txt"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("User-agent: *");
  });

  test("GET /api/products/:id returns correct params in production", async ({ request }) => {
    const response = await request.get(f.url("/api/products/99"));
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.id).toBe("99");
  });
});
