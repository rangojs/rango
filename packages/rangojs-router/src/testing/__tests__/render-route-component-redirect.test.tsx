// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { ErrorBoundary, useParams } from "../../client.js";
import { renderRoute } from "../dom.entry.js";
import { redirect } from "../../route-definition/redirect.js";
import { renderRedirectDigest } from "../../server/render-redirect-digest.js";

// Userland contract for a redirect() an async server component throws after
// its handler returned. The browser receives it as a Flight error row whose
// digest carries the redirect (component-redirect.rsc-test.tsx pins the row
// the server writes); React's Flight client rethrows it where the component
// sat. The router's boundaries follow it with a replace navigation, as a
// loader's redirect(), instead of showing the error page.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "");
});

/** The error React's Flight client throws for the gate's error row. */
function decodedRedirect(to: string): Error {
  const digest = renderRedirectDigest(redirect(to), {
    origin: window.location.origin,
    basename: undefined,
  });
  return Object.assign(
    new Error("An error occurred in the Server Components render."),
    { digest },
  );
}

function AccountGate(): never {
  throw decodedRedirect("/login");
}

describe("renderRoute: a server component's redirect()", () => {
  it("navigates to the target instead of showing the error page", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    function Page() {
      const { page } = useParams<{ page: string }>();
      return (
        <main>
          <h1 data-testid="page">{page}</h1>
          {page === "account" && <AccountGate />}
        </main>
      );
    }

    const { router, findByTestId, queryByText } = await renderRoute(
      [{ path: "/:page", Component: Page }],
      { request: "/account" },
    );

    await waitFor(() => expect(router.pathname()).toBe("/login"));
    expect((await findByTestId("page")).textContent).toBe("login");
    expect(queryByText("Internal Server Error")).toBeNull();
    // Control flow: the router's boundary logs nothing for it.
    expect(
      consoleError.mock.calls.filter((call) =>
        String(call[0]).includes("[RootErrorBoundary]"),
      ),
    ).toEqual([]);
  });

  it("an app's <ErrorBoundary> from the router hands it on instead of rendering its fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Page() {
      const { page } = useParams<{ page: string }>();
      return (
        <main>
          <h1 data-testid="page">{page}</h1>
          <ErrorBoundary fallback={<p data-testid="fallback">failed</p>}>
            {page === "account" && <AccountGate />}
          </ErrorBoundary>
        </main>
      );
    }

    const { router, findByTestId, queryByTestId } = await renderRoute(
      [{ path: "/:page", Component: Page }],
      { request: "/account" },
    );

    await waitFor(() => expect(router.pathname()).toBe("/login"));
    expect((await findByTestId("page")).textContent).toBe("login");
    expect(queryByTestId("fallback")).toBeNull();
  });

  it("an error that is not a redirect still shows the error page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never {
      throw Object.assign(new Error("broken"), { digest: "" });
    }

    const { router, findByText } = await renderRoute(
      [{ path: "/:page", Component: Broken }],
      { request: "/account" },
    );

    expect(await findByText("Internal Server Error")).toBeTruthy();
    expect(router.pathname()).toBe("/account");
  });
});
