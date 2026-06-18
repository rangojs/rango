import test, { expect } from "@playwright/test";
import { useFixture } from "./fixture";

// D6: a negotiated response must carry `Accept` in Vary exactly once. The
// upstream negotiation layer bakes `Vary: Accept`, and the handler post-append
// used to add a second `Accept` token (`Vary: Accept, Accept`) — a redundant
// token some proxies/CDNs treat as a distinct cache key. appendVaryAccept now
// dedups, so the consumer-visible header has a single `accept` token.
function expectVaryAcceptOnce(varyHeader: string | undefined): void {
  expect(varyHeader, "expected a Vary header").toBeTruthy();
  const acceptTokens = varyHeader!
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token === "accept");
  expect(acceptTokens).toEqual(["accept"]);
}

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

    // D6: the `accept` token must appear exactly once across each transport
    // (RSC, markdown, JSON, and the middleware-bearing route). A duplicate
    // `Vary: Accept, Accept` would be filed under a distinct cache key by
    // some intermediaries.
    test("emits Accept in Vary exactly once (no duplicate token)", async ({
      request,
    }) => {
      const rsc = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "text/x-component" },
      });
      expectVaryAcceptOnce(rsc.headers()["vary"]);

      const md = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "text/markdown" },
      });
      expectVaryAcceptOnce(md.headers()["vary"]);

      const json = await request.get(f.url("/negotiate-test"), {
        headers: { Accept: "application/json" },
      });
      expectVaryAcceptOnce(json.headers()["vary"]);

      // A negotiated route that also runs variant middleware (the middleware
      // appends a header after next()) must still dedup to a single token.
      const mwJson = await request.get(f.url("/negotiate-mw-test"), {
        headers: { Accept: "application/json" },
      });
      expectVaryAcceptOnce(mwJson.headers()["vary"]);
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

    // D6 (production): same single-token contract against the bundled build.
    test("emits Accept in Vary exactly once (no duplicate token)", async ({
      request,
    }) => {
      const rsc = await request.get(fProd.url("/negotiate-test"), {
        headers: { Accept: "text/x-component" },
      });
      expectVaryAcceptOnce(rsc.headers()["vary"]);

      const json = await request.get(fProd.url("/negotiate-test"), {
        headers: { Accept: "application/json" },
      });
      expectVaryAcceptOnce(json.headers()["vary"]);

      const mwJson = await request.get(fProd.url("/negotiate-mw-test"), {
        headers: { Accept: "application/json" },
      });
      expectVaryAcceptOnce(mwJson.headers()["vary"]);
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
