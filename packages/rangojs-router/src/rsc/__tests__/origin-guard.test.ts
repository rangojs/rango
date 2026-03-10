import { describe, it, expect } from "vitest";
import { validateRequestOrigin, checkRequestOrigin } from "../origin-guard.js";

function makeRequest(
  urlStr: string,
  headers: Record<string, string> = {},
  method = "POST",
): { request: Request; url: URL } {
  const url = new URL(urlStr);
  const request = new Request(urlStr, { method, headers });
  return { request, url };
}

describe("validateRequestOrigin", () => {
  it("allows same-origin request (Origin matches Host)", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com",
      Host: "example.com",
    });
    expect(validateRequestOrigin(request, url)).toBeNull();
  });

  it("rejects cross-origin request", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    const result = validateRequestOrigin(request, url);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("allows when no Origin and no Referer (non-browser client)", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Host: "example.com",
    });
    expect(validateRequestOrigin(request, url)).toBeNull();
  });

  it("falls back to Referer when Origin is absent", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Referer: "https://example.com/page",
      Host: "example.com",
    });
    expect(validateRequestOrigin(request, url)).toBeNull();
  });

  it("rejects cross-origin Referer when Origin is absent", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Referer: "https://evil.com/page",
      Host: "example.com",
    });
    const result = validateRequestOrigin(request, url);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("respects X-Forwarded-Host", () => {
    const { request, url } = makeRequest("https://internal.server/action", {
      Origin: "https://cdn.example.com",
      "X-Forwarded-Host": "cdn.example.com",
      "X-Forwarded-Proto": "https",
      Host: "internal.server",
    });
    expect(validateRequestOrigin(request, url)).toBeNull();
  });

  it("respects X-Forwarded-Proto", () => {
    const { request, url } = makeRequest("http://localhost/action", {
      Origin: "https://example.com",
      "X-Forwarded-Proto": "https",
      Host: "example.com",
    });
    expect(validateRequestOrigin(request, url)).toBeNull();
  });

  it("rejects mismatched port", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com:8080",
      Host: "example.com",
    });
    const result = validateRequestOrigin(request, url);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("case-insensitive host comparison", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://EXAMPLE.COM",
      Host: "example.com",
    });
    expect(validateRequestOrigin(request, url)).toBeNull();
  });

  it("allows malformed Referer (treats as absent)", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Referer: "not-a-url",
      Host: "example.com",
    });
    expect(validateRequestOrigin(request, url)).toBeNull();
  });

  it("rejects Origin: null (privacy-sensitive context)", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "null",
      Host: "example.com",
    });
    const result = validateRequestOrigin(request, url);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("includes diagnostic header on rejection", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    const result = validateRequestOrigin(request, url)!;
    expect(result.headers.get("X-Rango-Origin-Check")).toBe("failed");
  });
});

describe("checkRequestOrigin", () => {
  it("allows all requests when config is false", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    expect(await checkRequestOrigin(request, url, false)).toBeNull();
  });

  it("uses built-in validation when config is true", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(request, url, true);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("uses built-in validation when config is undefined", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(request, url, undefined);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("calls custom function and allows on true", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://trusted-partner.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(request, url, () => true);
    expect(result).toBeNull();
  });

  it("calls custom function and rejects on false", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(request, url, () => false);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("supports async custom function", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(request, url, async () => true);
    expect(result).toBeNull();
  });
});
