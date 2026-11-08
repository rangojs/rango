// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { cleanup, waitFor } from "@testing-library/react";
import { useParams } from "../../browser/react/use-params.js";
import { ErrorBoundary } from "../../client.js";
import { renderRoute } from "../render-route.js";
import { encodeRedirectDigest } from "../../redirect-signal.js";

afterEach(cleanup);

// A component's `throw redirect()` reaches the browser as a Flight error row
// whose digest carries the target (src/redirect-signal.ts): the router's own
// boundary must turn it into the loader lane's replace-navigation, not the
// error page. This is the client half a consumer sees on a click; the server
// half is pinned in component-redirect-signal.rsc-test.tsx and the whole path
// in e2e/component-redirect.test.ts.
//
// The thrown value is what React's Flight decoder builds from that row: an
// Error carrying `digest`. A component cannot call redirect() here — the
// browser build's redirect() is the server-only stub — so the wire shape is
// what the test reproduces.
function redirectError(to: string): Error {
  return Object.assign(new Error("Response"), {
    digest: encodeRedirectDigest({ to, status: 302 }),
  });
}

function Gate({ to }: { to: string }): ReactNode {
  throw redirectError(to);
}

function Page(): ReactNode {
  const { page } = useParams<{ page: string }>();
  if (page === "account") return <Gate to="/list/login" />;
  return <h1 data-testid="login">login</h1>;
}

/** The same throw under an app-placed boundary, the only other catcher. */
function BoundedPage(): ReactNode {
  const { page } = useParams<{ page: string }>();
  if (page === "account") {
    return (
      <ErrorBoundary fallback={<p data-testid="app-fallback">app failed</p>}>
        <Gate to="/list/login" />
      </ErrorBoundary>
    );
  }
  return <h1 data-testid="login">login</h1>;
}

describe("renderRoute: a component that throws redirect()", () => {
  it("replace-navigates to the target instead of showing the error page", async () => {
    const { getByTestId, router } = await renderRoute(
      [{ path: "/list/:page", Component: Page }],
      { request: "/list/account" },
    );

    await waitFor(() => expect(router.pathname()).toBe("/list/login"));
    expect(getByTestId("login").textContent).toBe("login");
    // The error page never renders.
    expect(document.body.textContent).not.toContain("Internal Server Error");
  });

  it("is not turned into an app ErrorBoundary's fallback", async () => {
    const { getByTestId, queryByTestId, router } = await renderRoute(
      [{ path: "/list/:page", Component: BoundedPage }],
      { request: "/list/account" },
    );

    await waitFor(() => expect(router.pathname()).toBe("/list/login"));
    expect(getByTestId("login").textContent).toBe("login");
    expect(queryByTestId("app-fallback")).toBeNull();
  });
});
