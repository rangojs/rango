import { describe, it, expect, vi, afterEach } from "vitest";
import { guardOutgoingRedirect } from "../redirect-guard.js";
import {
  resolveSameOriginRedirect,
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

  it("allows an off-host redirect carrying the external marker and strips it", () => {
    const res = redirectResponse("https://accounts.example.com/oauth", {
      headers: { [EXTERNAL_REDIRECT_MARKER]: "1" },
    });
    const out = guardOutgoingRedirect(res, ORIGIN, undefined);
    expect(out).toBe(res);
    expect(out.headers.get("Location")).toBe(
      "https://accounts.example.com/oauth",
    );
    // Internal marker never leaves the server.
    expect(out.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
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
