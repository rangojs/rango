// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { useParams } from "../../browser/react/use-params.js";
import { useSearchParams } from "../../browser/react/use-search-params.js";
import { renderRedirectDigest } from "../../errors.js";
import { ErrorBoundary, Outlet } from "../../client.js";
import { renderRoute } from "../render-route.js";

// Consumer contract: a redirect a server component threw, which React meets
// only while it renders the page (an async component nested in the handler's
// element, one behind loading()), lands on its target instead of the router's
// "Internal Server Error" page, and the layouts above the page stay mounted.
// The browser decodes such a component as an error carrying the digest the
// Flight render gave it (component-redirect-navigation.rsc-test.tsx pins what
// the server writes); the page segment's router boundary follows it with a
// replace navigation.

function decodedRedirectRow(pathname: string): Error {
  return Object.assign(new Error("decoded"), {
    digest: renderRedirectDigest({ to: window.location.origin + pathname }),
  });
}

let thrown: () => unknown = () => undefined;

function Page(): ReactNode {
  const { slug } = useParams<{ slug: string }>();
  if (slug === "throws") throw thrown();
  return <p data-testid="page">{slug}</p>;
}

async function mount() {
  const result = await renderRoute([{ path: "/:slug", Component: Page }], {
    request: "/start",
  });
  const read = () => result.queryByTestId("page")?.textContent ?? null;
  return { ...result, read };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("renderRoute: a component's redirect met while React renders", () => {
  it("lands on the target, replacing the page that redirected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    thrown = () => decodedRedirectRow("/target");
    const { router, read, queryByText } = await mount();
    expect(read()).toBe("start");

    await router.navigate("/throws");

    await waitFor(() => expect(read()).toBe("target"));
    expect(queryByText("Internal Server Error")).toBeNull();
  });

  // These pages differ by search only: renderRoute's synthetic layout keys by
  // the route's params, so a params change would remount it on any
  // navigation.
  function Gate(): ReactNode {
    const [search] = useSearchParams();
    if (search.get("go") === "1") throw decodedRedirectRow("/page?go=done");
    if (search.get("go") === "self") throw decodedRedirectRow("/page");
    return <p data-testid="page">{search.get("go") ?? "none"}</p>;
  }

  it("keeps the layout above the page mounted while it lands on the target", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let layoutMounts = 0;
    function Shell(): ReactNode {
      useEffect(() => {
        layoutMounts++;
      }, []);
      return (
        <main>
          <input data-testid="shell-input" />
          <Outlet />
        </main>
      );
    }
    const result = await renderRoute(
      [
        { path: "/", Component: Shell },
        { path: "/page", Component: Gate },
      ],
      { request: "/page?go=0" },
    );
    const input = result.getByTestId("shell-input") as HTMLInputElement;
    input.value = "kept";

    await result.router.navigate("/page?go=1");

    await waitFor(() =>
      expect(result.queryByTestId("page")?.textContent).toBe("done"),
    );
    expect(result.getByTestId("shell-input")).toBe(input);
    expect(input.value).toBe("kept");
    expect(layoutMounts).toBe(1);
    expect(result.queryByText("Internal Server Error")).toBeNull();
  });

  it("lands on a target on the same route and params, a new render of the page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await renderRoute([{ path: "/page", Component: Gate }], {
      request: "/page?go=0",
    });

    await result.router.navigate("/page?go=self");

    await waitFor(() =>
      expect(result.queryByTestId("page")?.textContent).toBe("none"),
    );
  });

  it("passes through an app's <ErrorBoundary> without its fallback or onError", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    thrown = () => decodedRedirectRow("/target");
    const onError = vi.fn();
    function Guarded(): ReactNode {
      return (
        <ErrorBoundary
          fallback={<p data-testid="app-fallback">app fallback</p>}
          onError={onError}
        >
          <Page />
        </ErrorBoundary>
      );
    }
    const result = await renderRoute([{ path: "/:slug", Component: Guarded }], {
      request: "/start",
    });

    await result.router.navigate("/throws");

    await waitFor(() =>
      expect(result.queryByTestId("page")?.textContent).toBe("target"),
    );
    expect(result.queryByTestId("app-fallback")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("still renders the error page for an ordinary render error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    thrown = () => Object.assign(new Error("boom"), { digest: "" });
    const { router, findByText, read } = await mount();

    await router.navigate("/throws");

    expect(await findByText("Internal Server Error")).toBeTruthy();
    expect(read()).toBeNull();
  });
});
