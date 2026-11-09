import { describe, expect, it } from "vitest";
import { renderRedirectOf } from "../render-redirect.js";
import {
  redirectAwareOnError,
  renderRedirectDigest,
  renderRedirectOrigin,
} from "../server/render-redirect-digest.js";
import { redirect } from "../route-definition/redirect.js";
import { attachRedirectState } from "../redirect-origin.js";
import { redirectSignalOf } from "../decode-loader-results.js";
import { isSignalError } from "../errors.js";

const ORIGIN = { origin: "https://shop.test", basename: undefined };

/** What React's Flight client builds from an error row with `digest`. */
const decoded = (digest: string | undefined): Error =>
  Object.assign(new Error("An error occurred"), { digest });

describe("renderRedirectDigest / renderRedirectOf", () => {
  it("round-trips a redirect's resolved target and status", () => {
    const digest = renderRedirectDigest(redirect("/login", 307), ORIGIN);

    expect(renderRedirectOf(decoded(digest))).toEqual({
      to: "https://shop.test/login",
      status: 307,
    });
  });

  it("carries the redirect's state", () => {
    const response = redirect("/login");
    attachRedirectState(response, { __rsc_ls_flash: { text: "hi" } });

    expect(
      renderRedirectOf(decoded(renderRedirectDigest(response, ORIGIN))),
    ).toEqual({
      to: "https://shop.test/login",
      status: 302,
      state: { __rsc_ls_flash: { text: "hi" } },
    });
  });

  it("still redirects, without the state, when JSON cannot hold it", () => {
    const response = redirect("/login");
    attachRedirectState(response, { __rsc_ls_big: 1n });

    expect(
      renderRedirectOf(decoded(renderRedirectDigest(response, ORIGIN))),
    ).toEqual({ to: "https://shop.test/login", status: 302 });
  });

  it("lands an off-origin target on the app root unless it opted in", () => {
    const blocked = renderRedirectDigest(redirect("https://evil.test/"), {
      origin: "https://shop.test",
      basename: "/app",
    });
    const external = renderRedirectDigest(
      redirect("https://pay.test/checkout", { external: true }),
      ORIGIN,
    );

    expect(renderRedirectOf(decoded(blocked))?.to).toBe("/app");
    expect(renderRedirectOf(decoded(external))?.to).toBe(
      "https://pay.test/checkout",
    );
  });

  it("passes on the digest of an error decoded from an inner encode", () => {
    const digest = renderRedirectDigest(redirect("/login"), ORIGIN);

    expect(renderRedirectDigest(decoded(digest), ORIGIN)).toBe(digest);
  });

  it("leaves everything else to React's own digest", () => {
    expect(
      renderRedirectDigest(new Response("no", { status: 403 }), ORIGIN),
    ).toBeUndefined();
    expect(renderRedirectDigest(new Error("boom"), ORIGIN)).toBeUndefined();
    expect(renderRedirectDigest(decoded(""), ORIGIN)).toBeUndefined();
    expect(renderRedirectOf(decoded(""))).toBeUndefined();
    expect(renderRedirectOf(decoded("rango.redirect;not json"))).toBe(
      undefined,
    );
    expect(renderRedirectOf(null)).toBeUndefined();
  });

  it("resolves against the original URL, before a rewrite", () => {
    expect(
      renderRedirectOrigin({
        originalUrl: new URL("https://shop.test/a"),
        url: new URL("https://internal.test/b"),
        _basename: "/app",
      }),
    ).toEqual({ origin: "https://shop.test", basename: "/app" });
    expect(renderRedirectOrigin(undefined)).toEqual({
      origin: undefined,
      basename: undefined,
    });
  });
});

describe("redirectAwareOnError", () => {
  it("reports every error, a redirect included, so a writer refuses the entry", () => {
    const seen: unknown[] = [];
    const onError = redirectAwareOnError(ORIGIN, (error) => seen.push(error));
    const response = redirect("/login");
    const failure = new Error("boom");

    expect(onError(response)).toMatch(/^rango\.redirect;/);
    expect(onError(failure)).toBeUndefined();
    expect(seen).toEqual([response, failure]);
  });
});

describe("the readers of a decoded component redirect", () => {
  const error = decoded(renderRedirectDigest(redirect("/login"), ORIGIN));

  it("redirectSignalOf reads it as the loader marker is read", () => {
    expect(redirectSignalOf(error)).toEqual({
      to: "https://shop.test/login",
      status: 302,
    });
  });

  it("isSignalError classifies it as control flow", () => {
    expect(isSignalError(error)).toBe(true);
    expect(isSignalError(decoded(""))).toBe(false);
  });
});
