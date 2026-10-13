// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useRouter } from "../../browser/react/use-router.js";
import { useHref } from "../../browser/react/use-href.js";
import { renderRoute } from "../render-route.js";

afterEach(() => {
  cleanup();
});

// Consumer contract: under include("/:accountId/:projectId", ...) the mount
// useMount() reports is the include's URL PATTERN. useHref() and relative
// useRouter().push/replace fill its params from the current match, the way
// useReverse does, so they never produce a URL with a literal ":accountId".
// renderRoute's `mount` takes the pattern exactly as production's MountContext
// carries it; `params` seeds the matched values.
const MOUNT = "/:accountId/:projectId";
const PARAMS = { accountId: "acme", projectId: "web" };

describe("useHref under a parameterized include() mount", () => {
  it("fills the mount params instead of concatenating the raw pattern", async () => {
    function Nav() {
      const href = useHref();
      return (
        <div>
          <a data-testid="issues" href={href("/issues")}>
            issues
          </a>
          <a data-testid="query" href={href("/issues?state=open#top")}>
            open
          </a>
        </div>
      );
    }
    const { getByTestId } = await renderRoute(
      [{ path: "/board", Component: Nav }],
      { mount: MOUNT, request: "/board", params: PARAMS },
    );
    expect(getByTestId("issues").getAttribute("href")).toBe("/acme/web/issues");
    expect(getByTestId("query").getAttribute("href")).toBe(
      "/acme/web/issues?state=open#top",
    );
  });

  it("throws Missing param when a mount param is not in the current match", async () => {
    let error: string | undefined;
    function Nav() {
      const href = useHref();
      try {
        href("/issues");
      } catch (e) {
        error = (e as Error).message;
      }
      return null;
    }
    await renderRoute([{ path: "/board", Component: Nav }], {
      mount: MOUNT,
      request: "/board",
      params: { accountId: "acme" },
    });
    expect(error).toBe(
      'Missing param "projectId" for route "/:accountId/:projectId"',
    );
  });

  it("keeps the returned function referentially stable across a re-render", async () => {
    const refs: Array<(p: `/${string}`) => string> = [];
    function Probe() {
      const href = useHref();
      const [, setN] = useState(0);
      refs.push(href);
      return (
        <button data-testid="rerender" onClick={() => setN((n) => n + 1)}>
          {href("/")}
        </button>
      );
    }
    const { getByTestId } = await renderRoute(
      [{ path: "/board", Component: Probe }],
      { mount: MOUNT, request: "/board", params: PARAMS },
    );
    const first = refs.at(-1);
    fireEvent.click(getByTestId("rerender"));
    expect(refs.length).toBeGreaterThan(1);
    expect(refs.at(-1)).toBe(first);
    expect(getByTestId("rerender").textContent).toBe("/acme/web/");
  });

  it("keeps the same function when only a non-mount param changes", async () => {
    // Drive the param change through the event controller (what a committed
    // navigation does) rather than router.navigate(), which rebuilds the
    // renderRoute tree and remounts the probe.
    const refs: Array<(p: `/${string}`) => string> = [];
    function Probe() {
      const href = useHref();
      refs.push(href);
      return <span data-testid="href">{href("/issues")}</span>;
    }
    const { getByTestId, router } = await renderRoute(
      [{ path: "/issues/:issueId", Component: Probe }],
      {
        mount: "/:accountId",
        request: "/issues/1",
        params: { accountId: "acme" },
      },
    );
    const first = refs.at(-1);
    const renders = refs.length;

    act(() => {
      router.eventController.setParams({ accountId: "acme", issueId: "2" });
      router.eventController.flushRouteState();
    });
    expect(refs.length).toBe(renders);

    act(() => {
      router.eventController.setParams({ accountId: "beta", issueId: "2" });
      router.eventController.flushRouteState();
    });
    expect(getByTestId("href").textContent).toBe("/beta/issues");
    expect(refs.at(-1)).not.toBe(first);
  });

  it("fills an optional /:locale? mount with and without the prefix", async () => {
    function Nav() {
      const href = useHref();
      return <span data-testid="menu">{href("/menu")}</span>;
    }
    const withLocale = await renderRoute([{ path: "/m", Component: Nav }], {
      mount: "/:locale?",
      request: "/m",
      params: { locale: "de" },
    });
    expect(withLocale.getByTestId("menu").textContent).toBe("/de/menu");
    cleanup();
    const withoutLocale = await renderRoute([{ path: "/m", Component: Nav }], {
      mount: "/:locale?",
      request: "/m",
    });
    expect(withoutLocale.getByTestId("menu").textContent).toBe("/menu");
  });

  it("leaves a static mount unchanged", async () => {
    function Nav() {
      const href = useHref();
      return <span data-testid="cart">{href("/cart")}</span>;
    }
    const { getByTestId } = await renderRoute(
      [{ path: "/c", Component: Nav }],
      { mount: "/shop", request: "/c" },
    );
    expect(getByTestId("cart").textContent).toBe("/shop/cart");
  });
});

describe("relative useRouter().push/replace under a parameterized include() mount", () => {
  function Buttons() {
    const router = useRouter();
    return (
      <div>
        <button data-testid="push" onClick={() => router.push("issues")}>
          push
        </button>
        <button
          data-testid="replace"
          onClick={() => router.replace("./settings?tab=members")}
        >
          replace
        </button>
        <button data-testid="absolute" onClick={() => router.push("/about")}>
          absolute
        </button>
      </div>
    );
  }

  it("push('issues') navigates to the filled mount URL", async () => {
    const { getByTestId, router } = await renderRoute(
      [{ path: "/board", Component: Buttons }],
      { mount: MOUNT, request: "/board", params: PARAMS },
    );
    fireEvent.click(getByTestId("push"));
    await waitFor(() => expect(router.pathname()).toBe("/acme/web/issues"));
  });

  it("replace('./settings?tab=members') keeps the query and fills the mount", async () => {
    const { getByTestId, router } = await renderRoute(
      [{ path: "/board", Component: Buttons }],
      { mount: MOUNT, request: "/board", params: PARAMS },
    );
    fireEvent.click(getByTestId("replace"));
    await waitFor(() => expect(router.pathname()).toBe("/acme/web/settings"));
  });

  it("rejects the returned promise (never throws) when a mount param is missing", async () => {
    let rejection: string | undefined;
    function Push() {
      const router = useRouter();
      return (
        <button
          data-testid="push"
          onClick={() => {
            router.push("issues").catch((e: Error) => {
              rejection = e.message;
            });
            router.prefetch("issues");
          }}
        >
          push
        </button>
      );
    }
    const { getByTestId, router } = await renderRoute(
      [{ path: "/board", Component: Push }],
      { mount: MOUNT, request: "/board", params: { accountId: "acme" } },
    );
    fireEvent.click(getByTestId("push"));
    await waitFor(() =>
      expect(rejection).toBe(
        'Missing param "projectId" for route "/:accountId/:projectId"',
      ),
    );
    expect(router.pathname()).toBe("/board");
  });

  it("leaves an app-absolute push alone", async () => {
    const { getByTestId, router } = await renderRoute(
      [{ path: "/board", Component: Buttons }],
      { mount: MOUNT, request: "/board", params: PARAMS },
    );
    fireEvent.click(getByTestId("absolute"));
    await waitFor(() => expect(router.pathname()).toBe("/about"));
  });
});
