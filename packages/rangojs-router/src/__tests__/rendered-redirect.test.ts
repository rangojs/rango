/**
 * The record a render's thrown redirect becomes, and the digest that carries
 * it to the browser (rendered-redirect.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { redirect } from "../route-definition/redirect.js";
import { attachRedirectState } from "../redirect-origin.js";
import {
  RENDERED_REDIRECT_DIGEST_PREFIX,
  renderedRedirectDigest,
  renderedRedirectFromError,
  renderedRedirectOf,
} from "../rendered-redirect.js";

const request = { origin: "https://app.test", basename: undefined };

describe("renderedRedirectOf", () => {
  it("resolves a same-origin target to its canonical href", () => {
    expect(renderedRedirectOf(redirect("/login"), request)).toEqual({
      to: "https://app.test/login",
      status: 302,
    });
  });

  it("keeps the redirect's own status", () => {
    expect(renderedRedirectOf(redirect("/login", 303), request)?.status).toBe(
      303,
    );
  });

  it("carries the resolved location state", () => {
    // Built by hand: redirect() reads the request context for its state.
    const response = new Response(null, {
      status: 302,
      headers: { Location: "/login" },
    });
    attachRedirectState(response, { __rsc_ls_flash: { text: "hi" } });

    expect(renderedRedirectOf(response, request)?.state).toEqual({
      __rsc_ls_flash: { text: "hi" },
    });
  });

  it("neutralizes a cross-origin target the app did not opt into", () => {
    // The same safe landing every other channel falls back to.
    expect(
      renderedRedirectOf(redirect("https://evil.test/phish"), request)?.to,
    ).toBe("/");
  });

  it("keeps an explicit external opt-in", () => {
    expect(
      renderedRedirectOf(
        redirect("https://accounts.test/oauth", { external: true }),
        request,
      )?.to,
    ).toBe("https://accounts.test/oauth");
  });

  it("is not control flow for a Response that is not a redirect", () => {
    expect(
      renderedRedirectOf(new Response("hi", { status: 200 }), request),
    ).toBe(undefined);
    expect(
      renderedRedirectOf(new Response(null, { status: 302 }), request),
    ).toBe(undefined);
    expect(renderedRedirectOf(new Error("boom"), request)).toBe(undefined);
  });

  it("keeps the raw target when there is no request to resolve against", () => {
    expect(renderedRedirectOf(redirect("/login"), undefined)?.to).toBe(
      "/login",
    );
  });
});

describe("the digest", () => {
  it("round-trips every field", () => {
    const redirectRecord = {
      to: "https://app.test/login",
      status: 303,
      state: { __rsc_ls_flash: { text: "hi" } },
    };
    const digest = renderedRedirectDigest(redirectRecord);

    expect(digest.startsWith(RENDERED_REDIRECT_DIGEST_PREFIX)).toBe(true);
    expect(renderedRedirectFromError({ digest })).toEqual(redirectRecord);
  });

  it("keeps the navigation and drops state JSON cannot encode", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const digest = renderedRedirectDigest({
      to: "https://app.test/login",
      status: 302,
      state: circular,
    });

    expect(renderedRedirectFromError({ digest })).toEqual({
      to: "https://app.test/login",
      status: 302,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("ignores any other error, digest or not", () => {
    expect(renderedRedirectFromError(new Error("masked"))).toBe(undefined);
    expect(renderedRedirectFromError({ digest: "abc123" })).toBe(undefined);
    expect(
      renderedRedirectFromError({
        digest: RENDERED_REDIRECT_DIGEST_PREFIX + "{not json",
      }),
    ).toBe(undefined);
    expect(
      renderedRedirectFromError({
        digest: RENDERED_REDIRECT_DIGEST_PREFIX + JSON.stringify({ to: 1 }),
      }),
    ).toBe(undefined);
    expect(renderedRedirectFromError(null)).toBe(undefined);
    expect(renderedRedirectFromError("rango:redirect;{}")).toBe(undefined);
  });
});
