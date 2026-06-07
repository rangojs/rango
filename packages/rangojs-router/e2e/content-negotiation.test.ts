import test, { expect } from "@playwright/test";
import { useFixture } from "./fixture";

test.describe("content-negotiation", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  // /negotiate-test has: RSC (first), then JSON, then MD
  test.describe("client order as tiebreaker (equal q-values)", () => {
    test("Accept: text/markdown,text/html,*/* prefers markdown (listed first)", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "text/markdown, text/html, */*" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      const body = await res.text();
      expect(body).toContain("# Negotiate Test MD");
    });

    test("Accept: text/html,text/markdown,*/* prefers HTML (listed first)", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "text/html, text/markdown, */*" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/html");
    });

    test("Accept: application/json,text/html prefers JSON (listed first)", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "application/json, text/html" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(body.source).toBe("json");
    });
  });

  test.describe("q-value priority", () => {
    test("text/markdown;q=0.5 loses to text/html;q=1.0", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "text/markdown;q=0.5, text/html" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/html");
    });

    test("text/html;q=0.9 loses to text/markdown;q=1.0", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "text/html;q=0.9, text/markdown" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
    });

    test("application/json;q=0.8 loses to text/markdown;q=0.9", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "application/json;q=0.8, text/markdown;q=0.9" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
    });
  });

  test.describe("browser-like Accept headers", () => {
    test("browser Accept header returns HTML (text/html is q=1.0, first)", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/html");
    });
  });

  test.describe("single type", () => {
    test("Accept: text/markdown returns markdown", async ({ request }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "text/markdown" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      const body = await res.text();
      expect(body).toContain("# Negotiate Test MD");
    });

    test("Accept: application/json returns JSON", async ({ request }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "application/json" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(body.source).toBe("json");
    });
  });

  // /negotiate-test has RSC defined first → */* returns RSC
  // /negotiate-test-json-first has JSON defined first → */* returns JSON
  test.describe("wildcard fallback follows definition order", () => {
    test("Accept: */* returns RSC when RSC is defined first", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "*/*" },
      });
      expect(res.status()).toBe(200);
      // RSC defined first → RSC wins for */*
      expect(res.headers()["content-type"]).toContain("text/x-component");
    });

    test("Accept: */* returns JSON when JSON is defined first", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-test-json-first"), {
        headers: { Accept: "*/*" },
      });
      expect(res.status()).toBe(200);
      // JSON defined first → JSON wins for */*
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(body.source).toBe("json");
    });

    test("no Accept header returns first defined (RSC)", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/x-component");
    });

    test("no Accept header returns first defined (JSON)", async ({
      request,
    }) => {
      // Retry: the first request to this route on a dev server may hit Vite
      // module transformation latency, causing a transient failure.
      await expect(async () => {
        const res = await request.get(f.url("/negotiate-test-json-first"), {
          headers: { Accept: "" },
        });
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("application/json");
      }).toPass({ timeout: 10000 });
    });
  });

  test.describe("Vary header", () => {
    test("all negotiated responses include Vary: Accept", async ({
      request,
    }) => {
      const html = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "text/html" },
      });
      expect(html.headers()["vary"]).toContain("Accept");

      const md = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "text/markdown" },
      });
      expect(md.headers()["vary"]).toContain("Accept");

      const json = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "application/json" },
      });
      expect(json.headers()["vary"]).toContain("Accept");
    });
  });

  test.describe("variant-specific middleware", () => {
    test("Accept: application/json runs JSON variant middleware", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-mw-test"), {
        headers: { Accept: "application/json" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(body.source).toBe("json");
      expect(res.headers()["x-variant-mw"]).toBe("json");
    });

    test("Accept: text/html runs RSC variant middleware", async ({
      request,
    }) => {
      const res = await request.get(f.url("/negotiate-mw-test"), {
        headers: { Accept: "text/html" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/html");
      expect(res.headers()["x-variant-mw"]).toBe("html");
    });
  });
});

// ---------------------------------------------------------------------------
// Production mode
// ---------------------------------------------------------------------------

test.describe("content-negotiation (production)", () => {
  const fProd = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.describe("client order as tiebreaker (equal q-values)", () => {
    test("Accept: text/markdown,text/html,*/* prefers markdown (listed first)", async ({
      request,
    }) => {
      const res = await request.get(fProd.url("/negotiate-test"), {
        headers: { Accept: "text/markdown, text/html, */*" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      const body = await res.text();
      expect(body).toContain("# Negotiate Test MD");
    });

    test("Accept: application/json,text/html prefers JSON (listed first)", async ({
      request,
    }) => {
      const res = await request.get(fProd.url("/negotiate-test"), {
        headers: { Accept: "application/json, text/html" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(body.source).toBe("json");
    });
  });

  test.describe("wildcard fallback follows definition order", () => {
    test("Accept: */* returns RSC when RSC is defined first", async ({
      request,
    }) => {
      const res = await request.get(fProd.url("/negotiate-test"), {
        headers: { Accept: "*/*" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/x-component");
    });

    test("Accept: */* returns JSON when JSON is defined first", async ({
      request,
    }) => {
      const res = await request.get(fProd.url("/negotiate-test-json-first"), {
        headers: { Accept: "*/*" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(body.source).toBe("json");
    });
  });

  test.describe("Vary header", () => {
    test("all negotiated responses include Vary: Accept", async ({
      request,
    }) => {
      const html = await request.get(fProd.url("/negotiate-test"), {
        headers: { Accept: "text/html" },
      });
      expect(html.headers()["vary"]).toContain("Accept");

      const json = await request.get(fProd.url("/negotiate-test"), {
        headers: { Accept: "application/json" },
      });
      expect(json.headers()["vary"]).toContain("Accept");
    });
  });

  test.describe("variant-specific middleware", () => {
    test("Accept: application/json runs JSON variant middleware", async ({
      request,
    }) => {
      const res = await request.get(fProd.url("/negotiate-mw-test"), {
        headers: { Accept: "application/json" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(body.source).toBe("json");
      expect(res.headers()["x-variant-mw"]).toBe("json");
    });

    test("Accept: text/html runs RSC variant middleware", async ({
      request,
    }) => {
      const res = await request.get(fProd.url("/negotiate-mw-test"), {
        headers: { Accept: "text/html" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/html");
      expect(res.headers()["x-variant-mw"]).toBe("html");
    });
  });
});
