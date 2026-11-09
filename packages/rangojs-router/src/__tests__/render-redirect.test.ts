import { describe, expect, it } from "vitest";
import { renderRedirectDigest, renderRedirectOf } from "../render-redirect.js";
import {
  attachRedirectState,
  markExternalRedirect,
} from "../redirect-origin.js";

/**
 * The digest a component-thrown `redirect()` travels in (`render-redirect.ts`)
 * carries the RESOLVED target, not the raw `Location`. The browser read site
 * hands it to `LoaderRedirect`, whose off-origin branch is the
 * `{ external: true }` channel, so a raw off-host target there would navigate
 * off-origin without the same-origin rule while a document load neutralizes
 * the same throw to the app root.
 */

const ORIGIN = "http://localhost:3000";

function redirectResponse(
  location: string,
  init: { status?: number; external?: boolean; state?: boolean } = {},
): Response {
  const response = new Response(null, {
    status: init.status ?? 302,
    headers: { Location: location },
  });
  if (init.external) markExternalRedirect(response);
  if (init.state) attachRedirectState(response, { flash: { text: "hi" } });
  return response;
}

/** The redirect the browser decodes from the digest. */
function decode(digest: string | undefined): unknown {
  expect(digest).toBeDefined();
  return renderRedirectOf({ digest });
}

describe("renderRedirectDigest", () => {
  it("resolves a root-relative target to the canonical same-origin href", () => {
    expect(
      decode(
        renderRedirectDigest(redirectResponse("/login"), ORIGIN, undefined),
      ),
    ).toEqual({
      location: "http://localhost:3000/login",
      status: 302,
    });
  });

  it("keeps the call's own status and the state it attached", () => {
    const digest = renderRedirectDigest(
      redirectResponse("/login?next=%2Faccount", { status: 307, state: true }),
      ORIGIN,
      undefined,
    );

    expect(decode(digest)).toEqual({
      location: "http://localhost:3000/login?next=%2Faccount",
      status: 307,
      state: { flash: { text: "hi" } },
    });
  });

  it("resolves a target that is already absolute and same-origin", () => {
    expect(
      decode(
        renderRedirectDigest(
          redirectResponse("http://localhost:3000/login"),
          ORIGIN,
          undefined,
        ),
      ),
    ).toEqual({ location: "http://localhost:3000/login", status: 302 });
  });

  it("neutralizes an off-host target with no opt-in to the app root", () => {
    // The same landing the document lane's outgoing guard gives the same
    // throw, so both lanes agree.
    expect(
      decode(
        renderRedirectDigest(
          redirectResponse("https://evil.example/x"),
          ORIGIN,
          undefined,
        ),
      ),
    ).toEqual({ location: "/", status: 302 });
  });

  it("lands a blocked target on the basename root", () => {
    expect(
      decode(
        renderRedirectDigest(
          redirectResponse("https://evil.example/x"),
          ORIGIN,
          "/app",
        ),
      ),
    ).toEqual({ location: "/app", status: 302 });
  });

  it("keeps a protocol-relative off-host target on the app root", () => {
    expect(
      decode(
        renderRedirectDigest(
          redirectResponse("//evil.example/x"),
          ORIGIN,
          undefined,
        ),
      ),
    ).toEqual({ location: "/", status: 302 });
  });

  it("keeps an opted-in http(s) off-host target and its opt-in", () => {
    expect(
      decode(
        renderRedirectDigest(
          redirectResponse("https://accounts.example.com/oauth", {
            external: true,
          }),
          ORIGIN,
          undefined,
        ),
      ),
    ).toEqual({
      location: "https://accounts.example.com/oauth",
      status: 302,
      external: true,
    });
  });

  it("neutralizes an opted-in non-http(s) target and drops the opt-in", () => {
    // `external` waives the same-origin rule, not scheme safety: the landing is
    // the app root, and it must not be advertised as an off-host opt-in.
    expect(
      decode(
        renderRedirectDigest(
          redirectResponse("javascript:alert(1)", { external: true }),
          ORIGIN,
          undefined,
        ),
      ),
    ).toEqual({ location: "/", status: 302 });
  });

  it("is undefined for a Response that is not a redirect", () => {
    expect(
      renderRedirectDigest(new Response("body"), ORIGIN, undefined),
    ).toBeUndefined();
  });

  it("is undefined for a value that is not a Response", () => {
    expect(
      renderRedirectDigest(new Error("boom"), ORIGIN, undefined),
    ).toBeUndefined();
  });
});
