import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

test.describe.configure({ mode: "serial" });

test.describe("response routes", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("GET /api/health returns JSON envelope with status ok", async ({
    request,
  }) => {
    const response = await request.get(f.url("/api/health"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.data.status).toBe("ok");
    expect(body.data.timestamp).toBeDefined();
    expect(body.error).toBeUndefined();
  });

  test("GET /api/products returns JSON envelope with array", async ({
    request,
  }) => {
    const response = await request.get(f.url("/api/products"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(3);
    expect(body.data[0].name).toBe("Widget");
  });

  test("GET /api/products/:id returns JSON envelope with params", async ({
    request,
  }) => {
    const response = await request.get(f.url("/api/products/1"));
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.id).toBe("1");
    expect(body.data.name).toBe("Widget");
  });

  test("GET /api/products/:id returns error envelope for non-existent product", async ({
    request,
  }) => {
    const response = await request.get(f.url("/api/products/999"));
    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.data).toBeUndefined();
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("not found");
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("GET /robots.txt returns plain text", async ({ request }) => {
    const response = await request.get(f.url("/robots.txt"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /api/");
  });

  test("response route does not return RSC Flight payload", async ({
    request,
  }) => {
    // Direct GET without RSC headers should return raw JSON, not Flight
    const response = await request.get(f.url("/api/health"));
    const contentType = response.headers()["content-type"] || "";
    expect(contentType).not.toContain("text/x-component");
    expect(contentType).toContain("application/json");
  });

  test("client navigation to response route triggers hard navigation", async ({
    page,
  }) => {
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

  test("partial request to response route returns X-RSC-Reload", async ({
    request,
  }) => {
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

test.describe("response routes (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("GET /api/health returns JSON envelope in production build", async ({
    request,
  }) => {
    const response = await request.get(f.url("/api/health"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.data.status).toBe("ok");
  });

  test("GET /robots.txt returns plain text in production build", async ({
    request,
  }) => {
    const response = await request.get(f.url("/robots.txt"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("User-agent: *");
  });

  test("GET /api/products/:id returns correct params in production", async ({
    request,
  }) => {
    const response = await request.get(f.url("/api/products/1"));
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.id).toBe("1");
    expect(body.data.name).toBe("Widget");
  });

  test("GET /api/products/:id returns error envelope in production for non-existent", async ({
    request,
  }) => {
    const response = await request.get(f.url("/api/products/999"));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
