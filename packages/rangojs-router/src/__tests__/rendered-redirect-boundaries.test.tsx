// @vitest-environment happy-dom

/**
 * A redirect() a server component throws reaches the browser as a Flight
 * error row whose digest names the target (rendered-redirect.ts). Both router
 * boundaries must mount LoaderRedirect for it instead of a fallback: the
 * per-segment one where the segment has loaders, the root one otherwise — the
 * reported signed-out visitor's page has no loader, so the root boundary is
 * what they hit. Each boundary's decision is read off its own render(), so no
 * provider or navigation is involved (the e2e covers the navigation itself).
 */
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";

import { LoaderRedirect } from "../loader-redirect.js";
import { StreamedLoaderErrorBoundary } from "../route-content-wrapper.js";
import { RootErrorBoundary } from "../root-error-boundary.js";
import { RENDERED_REDIRECT_DIGEST_PREFIX } from "../rendered-redirect.js";

function redirectError(to: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error("An error occurred in the Server Components render");
  (error as Error & { digest: string }).digest =
    RENDERED_REDIRECT_DIGEST_PREFIX +
    JSON.stringify({ to, status: 302, ...extra });
  return error;
}

function segmentDecision(error: unknown): unknown {
  const boundary = new StreamedLoaderErrorBoundary({
    children: null,
    reset: [],
  });
  boundary.state = { error, reset: [] };
  return boundary.render();
}

function rootDecision(error: unknown): unknown {
  const boundary = new RootErrorBoundary({ children: null });
  boundary.state = { hasError: true, error: error as Error };
  return boundary.render();
}

function isLoaderRedirect(node: unknown): node is ReactElement<{
  to: string;
  state?: Record<string, unknown>;
}> {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as ReactElement).type === LoaderRedirect
  );
}

describe("a rendered redirect at the router's boundaries", () => {
  it("the segment boundary navigates instead of rendering a fallback", () => {
    const node = segmentDecision(redirectError("http://localhost/login"));

    expect(isLoaderRedirect(node)).toBe(true);
    expect((node as ReactElement<{ to: string }>).props.to).toBe(
      "http://localhost/login",
    );
  });

  it("the root boundary navigates too: the reported page has no loader", () => {
    const node = rootDecision(
      redirectError("http://localhost/login", {
        state: { __rsc_ls_flash: { text: "Session expired" } },
      }),
    );

    expect(isLoaderRedirect(node)).toBe(true);
    expect(
      (node as ReactElement<{ state?: Record<string, unknown> }>).props.state,
    ).toEqual({ __rsc_ls_flash: { text: "Session expired" } });
  });

  it("any other error still renders the error page", () => {
    const node = rootDecision(new Error("boom"));

    expect(isLoaderRedirect(node)).toBe(false);
    expect(node).not.toBeNull();
  });

  it("a digest that is not a rendered redirect is not a navigation", () => {
    const error = new Error("masked");
    (error as Error & { digest: string }).digest = "abc123";

    expect(isLoaderRedirect(rootDecision(error))).toBe(false);
    // The segment boundary rethrows what carries no marker, as before.
    expect(() => segmentDecision(error)).toThrow(error);
  });
});
