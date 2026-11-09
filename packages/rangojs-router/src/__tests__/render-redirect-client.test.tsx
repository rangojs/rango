// @vitest-environment happy-dom

/**
 * A `throw redirect(...)` from a server component arrives in the browser as a
 * Flight error row whose digest carries the target (render-redirect.ts). Both
 * router-owned boundaries that can catch that row turn it into LoaderRedirect
 * (the same client replace a loader redirect takes) instead of an error page,
 * and RootErrorBoundary does not log it as a failure.
 *
 * LoaderRedirect navigates through useRouter, which needs a NavigationProvider;
 * a marker stands in for it here, as in action-loader-error-in-place.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../loader-redirect.js", () => ({
  LoaderRedirect: ({ to, state }: { to: string; state?: unknown }) => (
    <p>
      redirect:{to}
      {state ? ` state:${JSON.stringify(state)}` : ""}
    </p>
  ),
}));

import { RootErrorBoundary } from "../root-error-boundary.js";
import { StreamedLoaderErrorBoundary } from "../route-content-wrapper.js";
import { renderRedirectDigest } from "../render-redirect.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderRedirectThrown(redirect: {
  to: string;
  status: number;
  state?: Record<string, unknown>;
}): never {
  const error = new Error(
    "An error occurred in the Server Components render",
  ) as Error & { digest: string };
  error.digest = renderRedirectDigest(redirect);
  throw error;
}

describe("a render-time redirect in the browser", () => {
  it("StreamedLoaderErrorBoundary navigates instead of rendering its errorBoundary() fallback", () => {
    const result = render(
      <StreamedLoaderErrorBoundary reset={["R0"]}>
        <Gate />
      </StreamedLoaderErrorBoundary>,
    );

    expect(result.getByText("redirect:http://localhost/login")).toBeDefined();
  });

  it("StreamedLoaderErrorBoundary carries redirect(url, { state })", () => {
    const result = render(
      <StreamedLoaderErrorBoundary reset={["R0"]}>
        <StateGate />
      </StreamedLoaderErrorBoundary>,
    );

    expect(
      result.getByText('redirect:http://localhost/login state:{"flash":"x"}'),
    ).toBeDefined();
  });

  it("RootErrorBoundary navigates instead of showing the error page, and logs nothing", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const result = render(
      <RootErrorBoundary>
        <Gate />
      </RootErrorBoundary>,
    );

    expect(result.getByText("redirect:http://localhost/login")).toBeDefined();
    // React logs a caught error itself; the router's own line is the one that
    // would put a stack in the console for every signed-out visitor.
    expect(
      consoleError.mock.calls.filter((call) =>
        String(call[0]).includes("[RootErrorBoundary]"),
      ),
    ).toEqual([]);
  });

  it("RootErrorBoundary still shows the error page for an ordinary component throw", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = render(
      <RootErrorBoundary>
        <Boom />
      </RootErrorBoundary>,
    );

    expect(result.queryByText(/redirect:/)).toBeNull();
    expect(result.getByText("Internal Server Error")).toBeDefined();
  });
});

function Gate(): never {
  renderRedirectThrown({ to: "http://localhost/login", status: 302 });
}

function StateGate(): never {
  renderRedirectThrown({
    to: "http://localhost/login",
    status: 302,
    state: { flash: "x" },
  });
}

function Boom(): never {
  throw new Error("boom");
}
