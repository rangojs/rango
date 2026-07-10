import { describe, it, expect, vi, afterEach } from "vitest";
import { guardOutgoingRedirect } from "../redirect-guard.js";
import {
  resolveSameOriginRedirect,
  resolveExternalRedirect,
  resolveSoftRedirectUrl,
  markExternalRedirect,
  EXTERNAL_REDIRECT_MARKER,
} from "../../redirect-origin.js";

const ORIGIN = "https://app.example.com";

function redirectResponse(
  location: string,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(null, {
    status: init?.status ?? 302,
    headers: { Location: location, ...init?.headers },
  });
}

describe("resolveSameOriginRedirect (shared rule)", () => {
  it("normalizes relative paths to the current origin", () => {
    expect(resolveSameOriginRedirect("/dash", ORIGIN)).toBe(
      "https://app.example.com/dash",
    );
  });

  it("accepts same-origin absolute URLs", () => {
    expect(resolveSameOriginRedirect(`${ORIGIN}/x?q=1#h`, ORIGIN)).toBe(
      "https://app.example.com/x?q=1#h",
    );
  });

  it("rejects cross-origin and protocol-relative targets", () => {
    expect(resolveSameOriginRedirect("https://evil.com/p", ORIGIN)).toBeNull();
    expect(resolveSameOriginRedirect("//evil.com/p", ORIGIN)).toBeNull();
  });

  it("rejects different port / scheme", () => {
    expect(
      resolveSameOriginRedirect("https://app.example.com:9999/x", ORIGIN),
    ).toBeNull();
    expect(
      resolveSameOriginRedirect("http://app.example.com/x", ORIGIN),
    ).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(resolveSameOriginRedirect("http://[bad", ORIGIN)).toBeNull();
  });
});

describe("resolveSoftRedirectUrl (soft Flight / X-RSC-Redirect)", () => {
  it("normalizes same-origin relative targets", () => {
    expect(resolveSoftRedirectUrl("/dash", ORIGIN, undefined)).toBe(
      "https://app.example.com/dash",
    );
  });

  it("neutralizes cross-origin without external to basename root", () => {
    expect(
      resolveSoftRedirectUrl("https://evil.com/p", ORIGIN, undefined),
    ).toBe("/");
    expect(resolveSoftRedirectUrl("https://evil.com/p", ORIGIN, "/admin")).toBe(
      "/admin",
    );
  });

  it("allows external https and neutralizes javascript:", () => {
    expect(
      resolveSoftRedirectUrl(
        "https://accounts.example.com/oauth",
        ORIGIN,
        undefined,
        true,
      ),
    ).toBe("https://accounts.example.com/oauth");
    expect(
      resolveSoftRedirectUrl("javascript:alert(1)", ORIGIN, undefined, true),
    ).toBe("/");
  });
});

describe("resolveExternalRedirect (external scheme rule)", () => {
  it("accepts off-origin http(s) targets", () => {
    expect(
      resolveExternalRedirect("https://accounts.example.com/oauth", ORIGIN),
    ).toBe("https://accounts.example.com/oauth");
    expect(resolveExternalRedirect("http://other.example/x", ORIGIN)).toBe(
      "http://other.example/x",
    );
  });

  it("accepts same-origin http(s) targets (external is a superset)", () => {
    expect(resolveExternalRedirect("/dash", ORIGIN)).toBe(
      "https://app.example.com/dash",
    );
  });

  it("rejects javascript:, data:, and other non-http(s) schemes", () => {
    expect(
      resolveExternalRedirect("javascript:alert(document.cookie)", ORIGIN),
    ).toBeNull();
    expect(
      resolveExternalRedirect(
        "data:text/html,<script>alert(1)</script>",
        ORIGIN,
      ),
    ).toBeNull();
    expect(resolveExternalRedirect("vbscript:msgbox(1)", ORIGIN)).toBeNull();
    expect(
      resolveExternalRedirect("blob:https://app.example.com/x", ORIGIN),
    ).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(resolveExternalRedirect("http://[bad", ORIGIN)).toBeNull();
  });
});

describe("guardOutgoingRedirect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes non-redirect responses through untouched", () => {
    const res = new Response("ok", { status: 200 });
    expect(guardOutgoingRedirect(res, ORIGIN, undefined)).toBe(res);
  });

  it("passes same-origin redirects through untouched", () => {
    const res = redirectResponse("/dashboard", { status: 308 });
    const out = guardOutgoingRedirect(res, ORIGIN, undefined);
    expect(out).toBe(res);
    expect(out.headers.get("Location")).toBe("/dashboard");
  });

  it("passes same-origin absolute redirects through", () => {
    const res = redirectResponse(`${ORIGIN}/dashboard`);
    expect(guardOutgoingRedirect(res, ORIGIN, undefined)).toBe(res);
  });

  it("blocks a cross-origin redirect and rewrites Location to root", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = redirectResponse("https://evil.com/phish", { status: 302 });
    const out = guardOutgoingRedirect(res, ORIGIN, undefined);
    expect(out).not.toBe(res);
    expect(out.status).toBe(302);
    expect(out.headers.get("Location")).toBe("/");
  });

  it("blocks protocol-relative cross-origin redirects", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = redirectResponse("//evil.com/p");
    expect(
      guardOutgoingRedirect(res, ORIGIN, undefined).headers.get("Location"),
    ).toBe("/");
  });

  it("rewrites blocked Location to the basename root when configured", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = redirectResponse("https://evil.com/p");
    const out = guardOutgoingRedirect(res, ORIGIN, "/admin");
    expect(out.headers.get("Location")).toBe("/admin");
  });

  it("preserves cookies on the neutralized response", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = redirectResponse("https://evil.com/p", {
      headers: { "Set-Cookie": "session=abc; Path=/" },
    });
    const out = guardOutgoingRedirect(res, ORIGIN, undefined);
    expect(out.headers.get("Set-Cookie")).toContain("session=abc");
    expect(out.headers.get("Location")).toBe("/");
  });

  it("allows an off-host redirect carrying the out-of-band external brand and clears the marker", () => {
    const res = redirectResponse("https://accounts.example.com/oauth");
    markExternalRedirect(res);
    const out = guardOutgoingRedirect(res, ORIGIN, undefined);
    expect(out).toBe(res);
    expect(out.headers.get("Location")).toBe(
      "https://accounts.example.com/oauth",
    );
    // The reserved marker never leaves the server.
    expect(out.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
  });

  it("allows a branded same-origin redirect (external is a superset of same-origin)", () => {
    const res = redirectResponse("/dashboard");
    markExternalRedirect(res);
    const out = guardOutgoingRedirect(res, ORIGIN, undefined);
    expect(out).toBe(res);
    expect(out.headers.get("Location")).toBe("/dashboard");
  });

  // Finding #1 regression (forgeable opt-in): the external opt-in is an
  // out-of-band brand, NOT the wire header. A proxy-style response route that
  // copies an attacker-controlled upstream response's headers must NOT be able
  // to opt a redirect out of the same-origin guard by injecting this header.
  it("does NOT trust a forged external marker header; neutralizes the off-host target", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = redirectResponse("https://evil.example/phish", {
      headers: { [EXTERNAL_REDIRECT_MARKER]: "1" },
    });
    // Note: NOT branded -- the header is the only (forged) signal.
    const out = guardOutgoingRedirect(res, ORIGIN, undefined);
    expect(out).not.toBe(res);
    expect(out.headers.get("Location")).toBe("/");
    // The forged header is never propagated to the browser either.
    expect(out.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
  });

  // Finding #2 regression (unvalidated scheme): the external opt-in waives the
  // same-origin rule, NOT scheme safety. A branded redirect to a non-http(s)
  // target must still be neutralized so it can never reach the client's
  // window.location.assign() as a scriptable navigation.
  it("neutralizes a branded redirect to a javascript: target", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = redirectResponse("javascript:alert(document.cookie)");
    markExternalRedirect(res);
    const out = guardOutgoingRedirect(res, ORIGIN, undefined);
    expect(out).not.toBe(res);
    expect(out.headers.get("Location")).toBe("/");
  });

  it("neutralizes a branded redirect to a data: target", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = redirectResponse("data:text/html,<script>alert(1)</script>");
    markExternalRedirect(res);
    const out = guardOutgoingRedirect(res, ORIGIN, "/admin");
    expect(out).not.toBe(res);
    expect(out.headers.get("Location")).toBe("/admin");
  });

  it("logs the blocked target in dev", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    guardOutgoingRedirect(
      redirectResponse("https://evil.com/p"),
      ORIGIN,
      undefined,
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("https://evil.com/p"),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("external: true"));
  });
});
