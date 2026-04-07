import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Content ownership / negotiation edge-case tests.
 *
 * Proves which pipeline owns a given request:
 *   1. Negotiated routes select the correct owner per Accept header.
 *   2. Partial requests to response routes produce X-RSC-Reload, not data.
 *   3. Response route errors stay as response errors, not document shells.
 *   4. Guarded response routes reject without leaking protected payload.
 *   5. Middleware redirects on response routes fire without returning body.
 *   6. Behavior is identical in dev and production.
 */

// ---------------------------------------------------------------------------
// Dev mode
// ---------------------------------------------------------------------------

test.describe("content-ownership (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("negotiation precedence", () => {
    test("browser Accept selects document, not JSON", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/content-ownership/negotiated"));
      await waitForHydration(page);

      // Document pipeline rendered the page
      await expect(testId(page, "co-document-view")).toHaveText(
        "Document Owner",
      );
    });

    test("Accept: application/json selects JSON, not document shell", async ({
      request,
    }) => {
      const res = await request.get(f.url("/content-ownership/negotiated"), {
        headers: { Accept: "application/json" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");

      const body = await res.json();
      expect(body.data.owner).toBe("json");

      // Negative: no document shell leaked
      const text = JSON.stringify(body);
      expect(text).not.toContain("co-document-view");
      expect(text).not.toContain("Document Owner");
    });

    test("Vary: Accept present on all negotiated variants", async ({
      request,
    }) => {
      const html = await request.get(f.url("/content-ownership/negotiated"), {
        headers: { Accept: "text/html" },
      });
      expect(html.headers()["vary"]).toContain("Accept");

      const json = await request.get(f.url("/content-ownership/negotiated"), {
        headers: { Accept: "application/json" },
      });
      expect(json.headers()["vary"]).toContain("Accept");
    });
  });

  test.describe("partial request ownership", () => {
    test("partial request to plain JSON response returns X-RSC-Reload", async ({
      request,
    }) => {
      const res = await request.get(
        f.url(
          "/content-ownership/plain-json?_rsc_partial=true&_rsc_segments=M0L0",
        ),
      );
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rsc-reload"]).toBeDefined();

      // Negative: handler did NOT run — no JSON body
      const text = await res.text();
      expect(text).not.toContain("plain-response");
    });

    test("partial request to negotiated route (json selected) returns X-RSC-Reload", async ({
      request,
    }) => {
      const res = await request.get(
        f.url(
          "/content-ownership/negotiated?_rsc_partial=true&_rsc_segments=M0L0",
        ),
        { headers: { Accept: "application/json" } },
      );
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rsc-reload"]).toBeDefined();

      // Negative: JSON handler did NOT run
      const text = await res.text();
      expect(text).not.toContain("api-data");
    });
  });

  test.describe("error ownership", () => {
    test("JSON response route error returns JSON error, not document shell", async ({
      request,
    }) => {
      const res = await request.get(f.url("/content-ownership/error-json"));
      expect(res.status()).toBe(500);
      expect(res.headers()["content-type"]).toContain("application/json");

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain("intentional-response-error");

      // Negative: no document shell
      expect(body.data).toBeUndefined();
    });
  });

  test.describe("guarded response routes", () => {
    test("unauthenticated request returns 403 without leaking payload", async ({
      request,
    }) => {
      const res = await request.get(f.url("/content-ownership/guarded"));
      expect(res.status()).toBe(403);
      expect(res.headers()["content-type"]).toContain("application/json");

      const body = await res.json();
      expect(body.error).toBe("forbidden");

      // Negative: protected data did NOT leak
      expect(body.secret).toBeUndefined();
      expect(body.data).toBeUndefined();
    });

    test("authenticated request returns protected payload", async ({
      page,
      context,
    }) => {
      await context.addCookies([
        {
          name: "ownership-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      const response = await page.goto(f.url("/content-ownership/guarded"));
      expect(response?.status()).toBe(200);

      const body = await response?.json();
      expect(body.data.secret).toBe("classified-payload");
    });
  });

  test.describe("middleware redirect on response route", () => {
    test("redirect fires, handler body is NOT returned", async ({ page }) => {
      // No auth cookie → middleware redirects to /plain-json
      const response = await page.goto(
        f.url("/content-ownership/redirect-guarded"),
      );
      expect(response?.status()).toBe(200);

      const body = await response?.json();
      // Negative: original handler's body was NOT returned
      expect(JSON.stringify(body)).not.toContain("should-not-reach");
      // Positive: we got the redirect target's body
      expect(body.data.data).toBe("plain-response");
    });
  });
});

// ---------------------------------------------------------------------------
// Production mode
// ---------------------------------------------------------------------------

test.describe("content-ownership (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.describe("negotiation precedence", () => {
    test("browser Accept selects document, not JSON", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/content-ownership/negotiated"));
      await waitForHydration(page);

      await expect(testId(page, "co-document-view")).toHaveText(
        "Document Owner",
      );
    });

    test("Accept: application/json selects JSON, not document shell", async ({
      request,
    }) => {
      const res = await request.get(f.url("/content-ownership/negotiated"), {
        headers: { Accept: "application/json" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");

      const body = await res.json();
      expect(body.data.owner).toBe("json");

      const text = JSON.stringify(body);
      expect(text).not.toContain("co-document-view");
      expect(text).not.toContain("Document Owner");
    });

    test("Vary: Accept present on all negotiated variants", async ({
      request,
    }) => {
      const html = await request.get(f.url("/content-ownership/negotiated"), {
        headers: { Accept: "text/html" },
      });
      expect(html.headers()["vary"]).toContain("Accept");

      const json = await request.get(f.url("/content-ownership/negotiated"), {
        headers: { Accept: "application/json" },
      });
      expect(json.headers()["vary"]).toContain("Accept");
    });
  });

  test.describe("partial request ownership", () => {
    test("partial request to plain JSON response returns X-RSC-Reload", async ({
      request,
    }) => {
      const res = await request.get(
        f.url(
          "/content-ownership/plain-json?_rsc_partial=true&_rsc_segments=M0L0",
        ),
      );
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rsc-reload"]).toBeDefined();

      const text = await res.text();
      expect(text).not.toContain("plain-response");
    });

    test("partial request to negotiated route (json selected) returns X-RSC-Reload", async ({
      request,
    }) => {
      const res = await request.get(
        f.url(
          "/content-ownership/negotiated?_rsc_partial=true&_rsc_segments=M0L0",
        ),
        { headers: { Accept: "application/json" } },
      );
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rsc-reload"]).toBeDefined();

      const text = await res.text();
      expect(text).not.toContain("api-data");
    });
  });

  test.describe("error ownership", () => {
    test("JSON response route error returns JSON error, not document shell", async ({
      request,
    }) => {
      const res = await request.get(f.url("/content-ownership/error-json"));
      expect(res.status()).toBe(500);
      expect(res.headers()["content-type"]).toContain("application/json");

      const body = await res.json();
      expect(body.error).toBeDefined();
      // Production: error message is hidden
      expect(body.error.message).toBe("Internal Server Error");
      expect(body.data).toBeUndefined();
    });
  });

  test.describe("guarded response routes", () => {
    test("unauthenticated request returns 403 without leaking payload", async ({
      request,
    }) => {
      const res = await request.get(f.url("/content-ownership/guarded"));
      expect(res.status()).toBe(403);
      expect(res.headers()["content-type"]).toContain("application/json");

      const body = await res.json();
      expect(body.error).toBe("forbidden");
      expect(body.secret).toBeUndefined();
      expect(body.data).toBeUndefined();
    });

    test("authenticated request returns protected payload", async ({
      page,
      context,
    }) => {
      await context.addCookies([
        {
          name: "ownership-token",
          value: "valid",
          domain: "localhost",
          path: "/",
        },
      ]);

      const response = await page.goto(f.url("/content-ownership/guarded"));
      expect(response?.status()).toBe(200);

      const body = await response?.json();
      expect(body.data.secret).toBe("classified-payload");
    });
  });

  test.describe("middleware redirect on response route", () => {
    test("redirect fires, handler body is NOT returned", async ({ page }) => {
      const response = await page.goto(
        f.url("/content-ownership/redirect-guarded"),
      );
      expect(response?.status()).toBe(200);

      const body = await response?.json();
      expect(JSON.stringify(body)).not.toContain("should-not-reach");
      expect(body.data.data).toBe("plain-response");
    });
  });
});
