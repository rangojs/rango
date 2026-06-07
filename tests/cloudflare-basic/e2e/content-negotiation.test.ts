import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

test.describe.configure({ mode: "serial" });

test.describe("content negotiation (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("Accept: text/html returns HTML (RSC pipeline)", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);
    const contentType = response.headers()["content-type"] || "";
    // RSC pipeline serves HTML or RSC Flight payload
    expect(contentType).not.toContain("application/json");
  });

  test("Accept: application/json returns bare JSON", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate"), {
      headers: { Accept: "application/json" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ format: "json", negotiated: true });
  });

  test("no Accept header returns JSON (negotiate handler)", async ({
    request,
  }) => {
    const response = await request.fetch(f.url("/test/negotiate"), {
      headers: { Accept: "" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.format).toBe("json");
  });

  test("Accept: */* returns JSON (no explicit text/html)", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/negotiate"), {
      headers: { Accept: "*/*" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.format).toBe("json");
  });

  test("Vary: Accept present on negotiated JSON response", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/negotiate"), {
      headers: { Accept: "application/json" },
    });
    const vary = response.headers()["vary"] || "";
    expect(vary).toContain("Accept");
  });

  test("Vary: Accept present on HTML response from negotiated URL", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/negotiate"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    const vary = response.headers()["vary"] || "";
    // Both sides of a negotiated URL must set Vary: Accept for correct caching
    expect(vary).toContain("Accept");
    const contentType = response.headers()["content-type"] || "";
    expect(contentType).not.toContain("application/json");
  });

  // -- text negotiation --

  test("text negotiate: Accept text/html returns HTML", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-text"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);
    const contentType = response.headers()["content-type"] || "";
    expect(contentType).not.toContain("text/plain");
  });

  test("text negotiate: no text/html returns plain text", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/negotiate-text"), {
      headers: { Accept: "text/plain" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const body = await response.text();
    expect(body).toBe("plain text response");
  });

  test("text negotiate: Vary: Accept present", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-text"), {
      headers: { Accept: "text/plain" },
    });
    const vary = response.headers()["vary"] || "";
    expect(vary).toContain("Accept");
  });

  // -- xml negotiation --

  test("xml negotiate: Accept text/html returns HTML", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-xml"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);
    const contentType = response.headers()["content-type"] || "";
    expect(contentType).not.toContain("application/xml");
  });

  test("xml negotiate: no text/html returns XML", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-xml"), {
      headers: { Accept: "application/xml" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/xml");
    const body = await response.text();
    expect(body).toContain("<status>ok</status>");
  });

  test("xml negotiate: Vary: Accept present", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-xml"), {
      headers: { Accept: "application/xml" },
    });
    const vary = response.headers()["vary"] || "";
    expect(vary).toContain("Accept");
  });

  // -- multi-type negotiation (json + text + xml on same path) --

  test("multi negotiate: text/html returns HTML", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);
    const ct = response.headers()["content-type"] || "";
    expect(ct).not.toContain("application/json");
    expect(ct).not.toContain("text/plain");
    expect(ct).not.toContain("application/xml");
  });

  test("multi negotiate: application/json returns JSON", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "application/json" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ format: "json" });
  });

  test("multi negotiate: text/plain returns text", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "text/plain" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const body = await response.text();
    expect(body).toBe("plain text");
  });

  test("multi negotiate: application/xml returns XML", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "application/xml" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/xml");
    const body = await response.text();
    expect(body).toContain("<format>xml</format>");
  });

  test("multi negotiate: */* returns first variant (json)", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "*/*" },
    });
    expect(response.status()).toBe(200);
    // Falls back to first variant (json)
    expect(response.headers()["content-type"]).toContain("application/json");
  });

  // -- wildcard negotiation --

  test("wildcard negotiate: text/html returns HTML", async ({ request }) => {
    const response = await request.get(
      f.url("/test/negotiate-wild/some/path"),
      {
        headers: { Accept: "text/html,application/xhtml+xml" },
      },
    );
    expect(response.status()).toBe(200);
    const contentType = response.headers()["content-type"] || "";
    expect(contentType).not.toContain("application/json");
  });

  test("wildcard negotiate: application/json returns JSON with wildcard param", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/test/negotiate-wild/some/path"),
      {
        headers: { Accept: "application/json" },
      },
    );
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ format: "json", wildcard: "some/path" });
  });

  test("wildcard negotiate: Vary: Accept present", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-wild/foo"), {
      headers: { Accept: "application/json" },
    });
    const vary = response.headers()["vary"] || "";
    expect(vary).toContain("Accept");
  });

  test("multi negotiate: Vary: Accept on all negotiated responses", async ({
    request,
  }) => {
    const jsonRes = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "application/json" },
    });
    expect(jsonRes.headers()["vary"] || "").toContain("Accept");

    const textRes = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "text/plain" },
    });
    expect(textRes.headers()["vary"] || "").toContain("Accept");

    const xmlRes = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "application/xml" },
    });
    expect(xmlRes.headers()["vary"] || "").toContain("Accept");
  });
});

test.describe("content negotiation (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("Accept: application/json returns bare JSON in production", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/negotiate"), {
      headers: { Accept: "application/json" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ format: "json", negotiated: true });
  });

  test("Accept: text/html returns HTML in production", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);
    const contentType = response.headers()["content-type"] || "";
    expect(contentType).not.toContain("application/json");
  });

  test("Vary: Accept present on negotiated response in production", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/negotiate"), {
      headers: { Accept: "application/json" },
    });
    const vary = response.headers()["vary"] || "";
    expect(vary).toContain("Accept");
  });

  test("text negotiate: plain text in production", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-text"), {
      headers: { Accept: "text/plain" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const body = await response.text();
    expect(body).toBe("plain text response");
  });

  test("text negotiate: HTML in production", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-text"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);
    const contentType = response.headers()["content-type"] || "";
    expect(contentType).not.toContain("text/plain");
  });

  test("xml negotiate: XML in production", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-xml"), {
      headers: { Accept: "application/xml" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/xml");
    const body = await response.text();
    expect(body).toContain("<status>ok</status>");
  });

  test("xml negotiate: HTML in production", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-xml"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);
    const contentType = response.headers()["content-type"] || "";
    expect(contentType).not.toContain("application/xml");
  });

  test("multi negotiate: JSON in production", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "application/json" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ format: "json" });
  });

  test("multi negotiate: text in production", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "text/plain" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const body = await response.text();
    expect(body).toBe("plain text");
  });

  test("multi negotiate: XML in production", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "application/xml" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/xml");
    const body = await response.text();
    expect(body).toContain("<format>xml</format>");
  });

  test("multi negotiate: HTML in production", async ({ request }) => {
    const response = await request.get(f.url("/test/negotiate-multi"), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(response.status()).toBe(200);
    const ct = response.headers()["content-type"] || "";
    expect(ct).not.toContain("application/json");
    expect(ct).not.toContain("text/plain");
    expect(ct).not.toContain("application/xml");
  });

  test("wildcard negotiate: JSON in production", async ({ request }) => {
    const response = await request.get(
      f.url("/test/negotiate-wild/deep/path"),
      {
        headers: { Accept: "application/json" },
      },
    );
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ format: "json", wildcard: "deep/path" });
  });

  test("wildcard negotiate: HTML in production", async ({ request }) => {
    const response = await request.get(
      f.url("/test/negotiate-wild/deep/path"),
      {
        headers: { Accept: "text/html,application/xhtml+xml" },
      },
    );
    expect(response.status()).toBe(200);
    const contentType = response.headers()["content-type"] || "";
    expect(contentType).not.toContain("application/json");
  });
});
