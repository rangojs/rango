import { describe, it, expect } from "vitest";
import {
  defaultOriginCheck,
  checkRequestOrigin,
  type OriginCheckPhase,
} from "../origin-guard.js";

function makeRequest(
  urlStr: string,
  headers: Record<string, string> = {},
  method = "POST",
): { request: Request; url: URL } {
  const url = new URL(urlStr);
  const request = new Request(urlStr, { method, headers });
  return { request, url };
}

// Shared defaults for checkRequestOrigin calls
const defaultEnv = {};
const defaultRouterId = "test-router";
const defaultPhase: OriginCheckPhase = "action";

describe("defaultOriginCheck", () => {
  it("allows same-origin request (Origin matches Host)", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com",
      Host: "example.com",
    });
    expect(defaultOriginCheck(request, url)).toBe(true);
  });

  it("rejects cross-origin request", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    expect(defaultOriginCheck(request, url)).toBe(false);
  });

  it("allows when no Origin and no Referer (non-browser client)", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Host: "example.com",
    });
    expect(defaultOriginCheck(request, url)).toBe(true);
  });

  it("falls back to Referer when Origin is absent", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Referer: "https://example.com/page",
      Host: "example.com",
    });
    expect(defaultOriginCheck(request, url)).toBe(true);
  });

  it("rejects cross-origin Referer when Origin is absent", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Referer: "https://evil.com/page",
      Host: "example.com",
    });
    expect(defaultOriginCheck(request, url)).toBe(false);
  });

  it("ignores X-Forwarded-Host (client-controllable)", () => {
    const { request, url } = makeRequest("https://internal.server/action", {
      Origin: "https://cdn.example.com",
      "X-Forwarded-Host": "cdn.example.com",
      "X-Forwarded-Proto": "https",
      Host: "internal.server",
    });
    expect(defaultOriginCheck(request, url)).toBe(false);
  });

  it("ignores X-Forwarded-Proto (client-controllable)", () => {
    const { request, url } = makeRequest("http://localhost/action", {
      Origin: "https://example.com",
      "X-Forwarded-Proto": "https",
      Host: "example.com",
    });
    // Protocol mismatch: Origin says https but url.protocol is http
    expect(defaultOriginCheck(request, url)).toBe(false);
  });

  it("rejects mismatched port", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com:8080",
      Host: "example.com",
    });
    expect(defaultOriginCheck(request, url)).toBe(false);
  });

  it("case-insensitive host comparison", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://EXAMPLE.COM",
      Host: "example.com",
    });
    expect(defaultOriginCheck(request, url)).toBe(true);
  });

  it("allows malformed Referer (treats as absent)", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Referer: "not-a-url",
      Host: "example.com",
    });
    expect(defaultOriginCheck(request, url)).toBe(true);
  });

  it("rejects Origin: null (privacy-sensitive context)", () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "null",
      Host: "example.com",
    });
    expect(defaultOriginCheck(request, url)).toBe(false);
  });
});

describe("checkRequestOrigin", () => {
  it("allows all requests when config is false", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(
      request,
      url,
      false,
      defaultEnv,
      defaultRouterId,
      defaultPhase,
    );
    expect(result).toBeNull();
  });

  it("uses built-in validation when config is true", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(
      request,
      url,
      true,
      defaultEnv,
      defaultRouterId,
      defaultPhase,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(result!.headers.get("X-Rango-Origin-Check")).toBe("failed");
  });

  it("uses built-in validation when config is undefined", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(
      request,
      url,
      undefined,
      defaultEnv,
      defaultRouterId,
      defaultPhase,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("callback receives env", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com",
      Host: "example.com",
    });
    let receivedEnv: any;
    await checkRequestOrigin(
      request,
      url,
      (ctx) => {
        receivedEnv = ctx.env;
        return true;
      },
      { TRUST_PROXY: true },
      defaultRouterId,
      defaultPhase,
    );
    expect(receivedEnv).toEqual({ TRUST_PROXY: true });
  });

  it("callback receives correct phase", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com",
      Host: "example.com",
    });

    const phases: OriginCheckPhase[] = [];
    const check = (ctx: any) => {
      phases.push(ctx.phase);
      return true;
    };

    await checkRequestOrigin(request, url, check, defaultEnv, "r", "action");
    await checkRequestOrigin(request, url, check, defaultEnv, "r", "loader");
    await checkRequestOrigin(request, url, check, defaultEnv, "r", "pe-form");

    expect(phases).toEqual(["action", "loader", "pe-form"]);
  });

  it("callback receives routerId", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com",
      Host: "example.com",
    });
    let receivedId: string | undefined;
    await checkRequestOrigin(
      request,
      url,
      (ctx) => {
        receivedId = ctx.routerId;
        return true;
      },
      defaultEnv,
      "my-router",
      defaultPhase,
    );
    expect(receivedId).toBe("my-router");
  });

  it("defaultCheck() matches built-in behavior", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    let checkResult: boolean | undefined;
    await checkRequestOrigin(
      request,
      url,
      (ctx) => {
        checkResult = ctx.defaultCheck();
        return true; // allow anyway for this test
      },
      defaultEnv,
      defaultRouterId,
      defaultPhase,
    );
    expect(checkResult).toBe(false);
  });

  it("callback returning true allows request", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(
      request,
      url,
      () => true,
      defaultEnv,
      defaultRouterId,
      defaultPhase,
    );
    expect(result).toBeNull();
  });

  it("callback returning false rejects with default 403", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(
      request,
      url,
      () => false,
      defaultEnv,
      defaultRouterId,
      defaultPhase,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(result!.headers.get("X-Rango-Origin-Check")).toBe("failed");
  });

  it("callback returning Response is used verbatim", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://evil.com",
      Host: "example.com",
    });
    const customResponse = new Response("Custom rejection", {
      status: 401,
      headers: { "X-Custom": "auth-required" },
    });
    const result = await checkRequestOrigin(
      request,
      url,
      () => customResponse,
      defaultEnv,
      defaultRouterId,
      defaultPhase,
    );
    expect(result).toBe(customResponse);
    expect(result!.status).toBe(401);
    expect(result!.headers.get("X-Custom")).toBe("auth-required");
  });

  it("supports async callback", async () => {
    const { request, url } = makeRequest("https://example.com/action", {
      Origin: "https://example.com",
      Host: "example.com",
    });
    const result = await checkRequestOrigin(
      request,
      url,
      async () => true,
      defaultEnv,
      defaultRouterId,
      defaultPhase,
    );
    expect(result).toBeNull();
  });
});
