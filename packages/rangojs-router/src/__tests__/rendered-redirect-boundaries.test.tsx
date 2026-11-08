// @vitest-environment happy-dom

/**
 * A redirect() a server component throws reaches the browser as a Flight
 * error row whose digest names the target (rendered-redirect.ts). Both router
 * boundaries must mount LoaderRedirect for it instead of a fallback: the
 * per-segment one where the segment has loaders, the root one otherwise — the
 * reported signed-out visitor's page has no loader, so the root boundary is
 * what they hit.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

// LoaderRedirect navigates; a marker stands in for it here.
vi.mock("../loader-redirect.js", () => ({
  LoaderRedirect: ({ to }: { to: string }) =>
    createElement("p", { "data-testid": "redirecting" }, to),
}));

import { StreamedLoaderErrorBoundary } from "../route-content-wrapper.js";
import { RootErrorBoundary } from "../root-error-boundary.js";
import { RENDERED_REDIRECT_DIGEST_PREFIX } from "../rendered-redirect.js";

afterEach(cleanup);

function redirectError(to: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error("An error occurred in the Server Components render");
  (error as Error & { digest: string }).digest =
    RENDERED_REDIRECT_DIGEST_PREFIX +
    JSON.stringify({ to, status: 302, ...extra });
  return error;
}

function Throwing({ error }: { error: unknown }): never {
  throw error;
}

function renderIn(
  boundary: (children: ReactNode) => ReactNode,
  error: unknown,
) {
  return render(<>{boundary(<Throwing error={error} />)}</>);
}

describe("a rendered redirect at the router's boundaries", () => {
  it("the segment boundary navigates instead of rendering a fallback", () => {
    const result = renderIn(
      (children) => (
        <StreamedLoaderErrorBoundary reset={["R0"]}>
          {children}
        </StreamedLoaderErrorBoundary>
      ),
      redirectError("http://localhost/login"),
    );

    expect(result.getByTestId("redirecting").textContent).toBe(
      "http://localhost/login",
    );
  });

  it("the root boundary navigates too: the reported page has no loader", () => {
    const result = renderIn(
      (children) => <RootErrorBoundary>{children}</RootErrorBoundary>,
      redirectError("http://localhost/login"),
    );

    expect(result.getByTestId("redirecting").textContent).toBe(
      "http://localhost/login",
    );
  });

  it("any other error still renders the error page", () => {
    const result = renderIn(
      (children) => <RootErrorBoundary>{children}</RootErrorBoundary>,
      new Error("boom"),
    );

    expect(result.queryByTestId("redirecting")).toBeNull();
    expect(result.getByText("Internal Server Error")).toBeDefined();
  });

  it("a digest that is not a rendered redirect is not a navigation", () => {
    const error = new Error("masked");
    (error as Error & { digest: string }).digest = "abc123";
    const result = renderIn(
      (children) => <RootErrorBoundary>{children}</RootErrorBoundary>,
      error,
    );

    expect(result.queryByTestId("redirecting")).toBeNull();
    expect(result.getByText("Internal Server Error")).toBeDefined();
  });
});
