import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractRedirectResponse,
  warnNonRedirectPeResponse,
} from "../rsc/runtime-warnings.js";
import { guardOutgoingRedirect } from "../rsc/redirect-guard.js";
import {
  EXTERNAL_REDIRECT_MARKER,
  markExternalRedirect,
  isExternalRedirect,
} from "../redirect-origin.js";

describe("W3: PE action redirect handling", () => {
  it("extracts redirect from a 302 Response", () => {
    const response = new Response(null, {
      status: 302,
      headers: { Location: "/dashboard" },
    });
    const result = extractRedirectResponse(response);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(302);
    expect(result!.headers.get("Location")).toBe("/dashboard");
  });

  it("extracts redirect from a 301 Response", () => {
    const result = extractRedirectResponse(
      new Response(null, {
        status: 301,
        headers: { Location: "/new-path" },
      }),
    );
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(301);
  });

  it("returns null for non-redirect Response", () => {
    const result = extractRedirectResponse(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    expect(result).toBeNull();
  });

  it("returns null for Response without Location header", () => {
    const result = extractRedirectResponse(new Response(null, { status: 302 }));
    expect(result).toBeNull();
  });

  it("returns null for non-Response values", () => {
    expect(extractRedirectResponse("string")).toBeNull();
    expect(extractRedirectResponse(42)).toBeNull();
    expect(extractRedirectResponse(null)).toBeNull();
    expect(extractRedirectResponse(new Error("boom"))).toBeNull();
    expect(extractRedirectResponse({ status: 302 })).toBeNull();
  });

  it("preserves Set-Cookie and custom headers from original redirect", () => {
    const headers = new Headers();
    headers.set("Location", "/login");
    headers.append("Set-Cookie", "flash=done; Path=/");
    headers.append("Set-Cookie", "token=xyz; Path=/; HttpOnly");
    headers.set("X-Request-Id", "req-99");
    const response = new Response(null, { status: 302, headers });

    const result = extractRedirectResponse(response);
    expect(result).toBeInstanceOf(Response);

    const cookies = result!.headers.getSetCookie();
    expect(cookies).toContain("flash=done; Path=/");
    expect(cookies).toContain("token=xyz; Path=/; HttpOnly");
    expect(result!.headers.get("X-Request-Id")).toBe("req-99");
    // Location is on the wrapper, not carried over from source
    expect(result!.headers.get("Location")).toBe("/login");
  });

  // Regression: a PE action that does redirect(url, { external: true }) reaches
  // the browser via extractRedirectResponse. The out-of-band brand MUST transfer
  // onto the rebuilt Response so the downstream guard honors the off-host
  // opt-in; if it is dropped here, the guard neutralizes the redirect to root
  // and the documented { external: true } escape silently breaks for the entire
  // no-JS PE channel.
  it("transfers the external-redirect brand through extraction", () => {
    const response = new Response(null, {
      status: 302,
      headers: { Location: "https://accounts.example.com/oauth" },
    });
    markExternalRedirect(response);
    const result = extractRedirectResponse(response)!;
    expect(isExternalRedirect(result)).toBe(true);
    // The brand is out-of-band: no wire header is introduced by extraction.
    expect(result.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
  });

  // Finding #1 regression on the PE channel: a forged marker header (e.g. from a
  // proxied upstream response) is NOT the opt-in and must NOT survive
  // extraction, nor brand the rebuilt Response.
  it("does NOT carry a forged marker header (or brand) through extraction", () => {
    const response = new Response(null, {
      status: 302,
      headers: {
        Location: "https://evil.example/phish",
        [EXTERNAL_REDIRECT_MARKER]: "1",
      },
    });
    // No markExternalRedirect: the header is the only (forged) signal.
    const result = extractRedirectResponse(response)!;
    expect(result.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
    expect(isExternalRedirect(result)).toBe(false);
  });

  it("end-to-end: a PE external redirect (branded) survives extraction AND the guard allows it", () => {
    const response = new Response(null, {
      status: 302,
      headers: { Location: "https://accounts.example.com/oauth" },
    });
    markExternalRedirect(response);
    // PE path: extract, then the single handler chokepoint guards the result.
    const extracted = extractRedirectResponse(response)!;
    const guarded = guardOutgoingRedirect(
      extracted,
      "https://myapp.example",
      undefined,
    );
    // Off-host target allowed (NOT rewritten to root) and no marker leaks.
    expect(guarded.headers.get("Location")).toBe(
      "https://accounts.example.com/oauth",
    );
    expect(guarded.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
  });

  it("end-to-end: a forged-marker PE redirect is neutralized by the guard", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = new Response(null, {
      status: 302,
      headers: {
        Location: "https://evil.example/phish",
        [EXTERNAL_REDIRECT_MARKER]: "1",
      },
    });
    const extracted = extractRedirectResponse(response)!;
    const guarded = guardOutgoingRedirect(
      extracted,
      "https://myapp.example",
      undefined,
    );
    expect(guarded.headers.get("Location")).toBe("/");
    expect(guarded.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
    spy.mockRestore();
  });
});

describe("W3: PE non-redirect Response warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns about non-redirect Response in PE mode", () => {
    warnNonRedirectPeResponse();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain("progressive enhancement");
  });
});
