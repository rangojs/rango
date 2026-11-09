// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { NavigationStoreContext } from "../browser/react/context.js";
import type { NavigationStoreContextValue } from "../browser/react/context.js";
import { RootErrorBoundary } from "../root-error-boundary.js";
import { renderRedirectDigest } from "../render-redirect.js";
import {
  attachRedirectState,
  markExternalRedirect,
} from "../redirect-origin.js";

/**
 * A `redirect()` thrown from a server component arrives in the browser as the
 * Flight error row's digest (`render-redirect.ts`). The router's outermost
 * boundary is where it lands, so it must navigate there instead of rendering
 * the error page.
 */

/** The origin the server resolved the digest against (this window's). */
const REQUEST_ORIGIN = "http://localhost:3000";

const navigations: Array<{ url: string; options?: unknown }> = [];

/** The navigation entry `LoaderRedirect` reaches through useRouter().replace. */
const navigationContext = {
  basename: undefined,
  navigate: (url: string, options?: unknown) => {
    navigations.push({ url, options });
    return Promise.resolve();
  },
  eventController: { getParams: () => ({}) },
} as unknown as NavigationStoreContextValue;

function Providers({ children }: { children: ReactNode }): ReactNode {
  return (
    <NavigationStoreContext.Provider value={navigationContext}>
      {children}
    </NavigationStoreContext.Provider>
  );
}

/** The error the Flight client rebuilds from a redirect's error row. */
function decodedRedirect(digest: string): Error {
  const error = new Error(
    "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance which may provide additional details about the nature of the error.",
  );
  (error as Error & { digest: string }).digest = digest;
  return error;
}

function Throws({ error }: { error: unknown }): ReactNode {
  throw error;
}

function renderBoundary(error: unknown): HTMLElement {
  const { container } = render(
    <Providers>
      <RootErrorBoundary>
        <Throws error={error} />
      </RootErrorBoundary>
    </Providers>,
  );
  return container;
}

afterEach(() => {
  cleanup();
  navigations.length = 0;
  vi.restoreAllMocks();
});

describe("RootErrorBoundary: a redirect a component threw", () => {
  it("replaces to the target instead of rendering the error page", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const digest = renderRedirectDigest(
      new Response(null, { status: 302, headers: { Location: "/login" } }),
      REQUEST_ORIGIN,
      undefined,
    )!;

    const container = renderBoundary(decodedRedirect(digest));

    expect(navigations.map((n) => n.url)).toEqual([
      "http://localhost:3000/login",
    ]);
    expect(navigations[0]!.options).toMatchObject({ replace: true });
    expect(container.textContent).not.toContain("Internal Server Error");
  });

  it("carries redirect(url, { state }) onto the target's history entry", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = new Response(null, {
      status: 307,
      headers: { Location: "/login?next=%2Faccount" },
    });
    attachRedirectState(response, { flash: { text: "signed out" } });

    renderBoundary(
      decodedRedirect(
        renderRedirectDigest(response, REQUEST_ORIGIN, undefined)!,
      ),
    );

    expect(navigations[0]!.url).toBe(
      "http://localhost:3000/login?next=%2Faccount",
    );
    expect(navigations[0]!.options).toMatchObject({
      replace: true,
      state: { flash: { text: "signed out" } },
    });
  });

  it("prints nothing: the redirect is control flow, not a failure", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const digest = renderRedirectDigest(
      new Response(null, { status: 302, headers: { Location: "/login" } }),
      REQUEST_ORIGIN,
      undefined,
    )!;

    renderBoundary(decodedRedirect(digest));

    expect(
      consoleError.mock.calls.filter(([message]) =>
        String(message).includes("[RootErrorBoundary]"),
      ),
    ).toEqual([]);
  });

  it("lands an off-host target with no opt-in on the app root, never off-origin", () => {
    // LoaderRedirect's off-origin branch is the `{ external: true }` channel:
    // a raw off-host target here would be an unguarded window.location.replace,
    // while the document lane's outgoing guard neutralizes the same throw. The
    // digest carries the resolved landing, so the two agree.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {});
    const digest = renderRedirectDigest(
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/x" },
      }),
      REQUEST_ORIGIN,
      undefined,
    )!;

    const container = renderBoundary(decodedRedirect(digest));

    expect(replace).not.toHaveBeenCalled();
    expect(navigations.map((n) => n.url)).toEqual(["http://localhost:3000/"]);
    expect(container.textContent).not.toContain("Internal Server Error");
  });

  it("leaves for an opted-in { external: true } target, not through the router", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {});
    const response = new Response(null, {
      status: 302,
      headers: { Location: "https://accounts.example.com/oauth" },
    });
    markExternalRedirect(response);

    renderBoundary(
      decodedRedirect(
        renderRedirectDigest(response, REQUEST_ORIGIN, undefined)!,
      ),
    );

    expect(replace).toHaveBeenCalledWith("https://accounts.example.com/oauth");
    expect(navigations).toEqual([]);
  });

  it("still renders the error page for an ordinary render error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const container = renderBoundary(new Error("boom"));

    expect(navigations).toEqual([]);
    expect(container.textContent).toContain("Internal Server Error");
  });

  it("still renders the error page for a Flight error row with no digest", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const container = renderBoundary(decodedRedirect(""));

    expect(navigations).toEqual([]);
    expect(container.textContent).toContain("Internal Server Error");
  });
});
