import { describe, it, expect } from "vitest";
import { resolveShellHitRedirectTarget } from "../rsc-rendering.js";

// The shell-HIT degradation (serveShellHit) emits an inline
// `location.replace(<target>)` when a cached shell HITs on a URL whose route
// became redirecting mid-TTL. That inline navigation bypasses the 3xx +
// Location chokepoint (guardOutgoingRedirect), so the target must be run
// through the SAME same-origin resolver first. These cases pin that a
// caller-influenced cross-origin target can never become an off-host
// navigation, mirroring redirect-guard.ts's own basename-root fallback.
const ORIGIN = "https://app.example.com";

describe("resolveShellHitRedirectTarget (shell-HIT degradation guard)", () => {
  it("neutralizes a cross-origin target to the app root when basename is unset", () => {
    expect(
      resolveShellHitRedirectTarget(
        "https://evil.example/phish",
        ORIGIN,
        undefined,
      ),
    ).toBe("/");
  });

  it("neutralizes a cross-origin target to the configured basename", () => {
    expect(
      resolveShellHitRedirectTarget(
        "https://evil.example/phish",
        ORIGIN,
        "/admin",
      ),
    ).toBe("/admin");
  });

  it("neutralizes a protocol-relative (//evil) target off-host", () => {
    expect(
      resolveShellHitRedirectTarget("//evil.example/phish", ORIGIN, undefined),
    ).toBe("/");
  });

  it("passes a safe same-origin relative target through as its normalized href", () => {
    // resolveSameOriginRedirect normalizes to an absolute same-origin href; the
    // navigation lands on the intended path, just canonicalized.
    expect(resolveShellHitRedirectTarget("/dashboard", ORIGIN, undefined)).toBe(
      "https://app.example.com/dashboard",
    );
  });

  it("passes a safe same-origin absolute target through unchanged", () => {
    expect(
      resolveShellHitRedirectTarget(
        `${ORIGIN}/dashboard?x=1`,
        ORIGIN,
        undefined,
      ),
    ).toBe("https://app.example.com/dashboard?x=1");
  });
});
