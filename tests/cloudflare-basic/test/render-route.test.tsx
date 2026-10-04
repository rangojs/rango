// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { createPortal } from "react-dom";
import { renderRoute } from "@rangojs/router/testing/dom";
import { Link } from "@rangojs/router/client";
import { CRClientNav } from "../src/components/CRClientNav.js";

const activePrefetchElements = new Set<Element>();
const observePrefetchElement = vi.fn((element: Element) =>
  activePrefetchElements.add(element),
);
const disconnectPrefetchObserver = vi.fn();

class TestIntersectionObserver {
  observe = observePrefetchElement;
  unobserve = (element: Element) => activePrefetchElements.delete(element);
  disconnect = disconnectPrefetchObserver;
}

beforeEach(() => {
  activePrefetchElements.clear();
  vi.clearAllMocks();
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

afterEach(() => {
  cleanup();
  configure({ reactStrictMode: false });
  vi.unstubAllGlobals();
});

describe("renderRoute against cloudflare-basic client components", () => {
  // CRClientNav is a REAL "use client" component reading router context:
  // useParams() + useReverse(crRoutes) + <Link>. renderRoute mounts it in the
  // router's NavigationProvider with a synthetic segment tree (client-tree
  // fidelity only: no server render, no Flight, loaders seeded not run).
  it("reads route params via useParams()", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/cr/:tenantId/posts/:postId", Component: CRClientNav }],
      { request: "/cr/acme/posts/p1" },
    );
    expect(getByTestId("cr-cf-tenant").textContent).toBe("acme");
  });

  it("resolves useReverse() against the component's route map", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/cr/:tenantId/posts/:postId", Component: CRClientNav }],
      { request: "/cr/acme/posts/p1" },
    );
    // crRoutes = { index: "/", post: "/posts/:postId" }. The dotted and
    // non-dotted forms must resolve identically (PR #529), and an explicit
    // postId fills the :postId segment.
    const explicit = getByTestId("cr-cf-post-explicit").textContent;
    const nodot = getByTestId("cr-cf-post-nodot").textContent;
    expect(explicit).toContain("/posts/p1");
    expect(nodot).toBe(explicit); // leading dot is optional
    expect(getByTestId("cr-cf-index-nodot").textContent).toBe(
      getByTestId("cr-cf-index").textContent,
    );
  });

  it("re-resolves params after a client-side navigate()", async () => {
    const { getByTestId, router } = await renderRoute(
      [{ path: "/cr/:tenantId/posts/:postId", Component: CRClientNav }],
      { request: "/cr/acme/posts/p1" },
    );
    expect(getByTestId("cr-cf-tenant").textContent).toBe("acme");
    await router.navigate("/cr/zeta/posts/p9");
    expect(router.params()).toMatchObject({ tenantId: "zeta", postId: "p9" });
    expect(getByTestId("cr-cf-tenant").textContent).toBe("zeta");
  });

  it("scopes defaultPrefetch per tree and preserves it through StrictMode", async () => {
    configure({ reactStrictMode: true });

    function PlainAnchors() {
      return (
        <>
          <Link to="/pricing" data-testid="pricing-link">
            Pricing
          </Link>
          <a href="/docs" data-testid="docs-link">
            Docs
          </a>
          <a href="/logout" data-prefetch="false">
            Log out
          </a>
        </>
      );
    }

    const { getByTestId } = await renderRoute(
      [{ path: "/", Component: PlainAnchors }],
      { request: "/", defaultPrefetch: "viewport" },
    );

    expect(activePrefetchElements.has(getByTestId("pricing-link"))).toBe(true);
    expect(activePrefetchElements.has(getByTestId("docs-link"))).toBe(true);

    cleanup();
    await Promise.resolve();
    configure({ reactStrictMode: false });
    expect(activePrefetchElements.size).toBe(0);
    expect(disconnectPrefetchObserver).toHaveBeenCalledOnce();

    function FirstTree() {
      return <a href="/first" data-testid="first-link" />;
    }
    function SecondTree() {
      return <a href="/second" data-testid="second-link" />;
    }

    const first = await renderRoute([{ path: "/", Component: FirstTree }], {
      request: "/",
      defaultPrefetch: "viewport",
    });
    const second = await renderRoute([{ path: "/", Component: SecondTree }], {
      request: "/",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(activePrefetchElements.has(first.getByTestId("first-link"))).toBe(
      true,
    );
    expect(activePrefetchElements.has(second.getByTestId("second-link"))).toBe(
      false,
    );

    first.unmount();
    await Promise.resolve();
    expect(disconnectPrefetchObserver).toHaveBeenCalledOnce();

    second.unmount();
    await Promise.resolve();
    expect(disconnectPrefetchObserver).toHaveBeenCalledTimes(2);
  });

  it("uses the shared IntersectionObserver test stub", async () => {
    function CurrentTree() {
      return (
        <>
          <a href="/app/current" data-testid="current-link" />
          <a href="/app/files/report.pdf" data-testid="asset-link" />
          <a
            href="/app/reports/2026.csv"
            data-prefetch="true"
            data-testid="resource-route-link"
          />
          <a href="/app/logout" data-prefetch="none" data-testid="none-link" />
          <a href="/sibling/current" data-testid="sibling-link" />
          <a href="/app%2Fadmin" data-testid="encoded-separator-link" />
          <section data-prefetch-scope="false">
            <Link
              to="/current"
              prefetch="viewport"
              data-testid="scoped-component-link"
            >
              Scoped Link
            </Link>
            <a
              href="/app/scoped"
              data-prefetch="true"
              data-testid="scoped-plain-link"
            />
          </section>
          <svg>
            <a href="/app/svg" data-testid="svg-link" />
          </svg>
        </>
      );
    }
    const result = await renderRoute([{ path: "/", Component: CurrentTree }], {
      request: "/",
      basename: "/app",
      defaultPrefetch: "viewport",
    });

    expect(observePrefetchElement).toHaveBeenCalledWith(
      result.getByTestId("current-link"),
    );
    expect(observePrefetchElement).not.toHaveBeenCalledWith(
      result.getByTestId("asset-link"),
    );
    expect(observePrefetchElement).toHaveBeenCalledWith(
      result.getByTestId("resource-route-link"),
    );
    expect(observePrefetchElement).not.toHaveBeenCalledWith(
      result.getByTestId("none-link"),
    );
    expect(observePrefetchElement).not.toHaveBeenCalledWith(
      result.getByTestId("sibling-link"),
    );
    expect(observePrefetchElement).not.toHaveBeenCalledWith(
      result.getByTestId("encoded-separator-link"),
    );
    expect(observePrefetchElement).not.toHaveBeenCalledWith(
      result.getByTestId("scoped-component-link"),
    );
    expect(observePrefetchElement).not.toHaveBeenCalledWith(
      result.getByTestId("scoped-plain-link"),
    );
    expect(observePrefetchElement).not.toHaveBeenCalledWith(
      result.getByTestId("svg-link"),
    );
  });

  it("uses the IntersectionObserver installed for each isolated render", async () => {
    const firstObserve = vi.fn();
    const firstDisconnect = vi.fn();
    class FirstIntersectionObserver {
      observe = firstObserve;
      unobserve = vi.fn();
      disconnect = firstDisconnect;
    }
    vi.stubGlobal("IntersectionObserver", FirstIntersectionObserver);

    function ViewportAnchor() {
      return <a href="/target" data-testid="target-link" />;
    }

    const first = await renderRoute(
      [{ path: "/", Component: ViewportAnchor }],
      { request: "/", defaultPrefetch: "viewport" },
    );
    const firstTarget = first.getByTestId("target-link");

    cleanup();

    const secondObserve = vi.fn();
    class SecondIntersectionObserver {
      observe = secondObserve;
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", SecondIntersectionObserver);

    const second = await renderRoute(
      [{ path: "/", Component: ViewportAnchor }],
      { request: "/", defaultPrefetch: "viewport" },
    );

    expect(firstObserve).toHaveBeenCalledWith(firstTarget);
    expect(firstDisconnect).toHaveBeenCalledOnce();
    expect(secondObserve).toHaveBeenCalledWith(
      second.getByTestId("target-link"),
    );
  });

  it("uses the matchMedia query installed for each isolated render", async () => {
    const firstAdd = vi.fn();
    const firstRemove = vi.fn();
    const firstMatchMedia = vi.fn(
      () =>
        ({
          matches: false,
          addEventListener: firstAdd,
          removeEventListener: firstRemove,
        }) as unknown as MediaQueryList,
    );
    vi.stubGlobal("matchMedia", firstMatchMedia);

    function AdaptiveAnchor() {
      return <a href="/target" />;
    }

    await renderRoute([{ path: "/", Component: AdaptiveAnchor }], {
      request: "/",
      defaultPrefetch: "adaptive",
    });
    expect(firstMatchMedia).toHaveBeenCalledWith("(hover: none)");

    cleanup();
    expect(firstRemove).toHaveBeenCalledWith("change", expect.any(Function));

    const secondAdd = vi.fn();
    const secondMatchMedia = vi.fn(
      () =>
        ({
          matches: true,
          addEventListener: secondAdd,
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    vi.stubGlobal("matchMedia", secondMatchMedia);

    await renderRoute([{ path: "/", Component: AdaptiveAnchor }], {
      request: "/",
      defaultPrefetch: "adaptive",
    });

    expect(secondMatchMedia).toHaveBeenCalledWith("(hover: none)");
    expect(secondAdd).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("re-arms delegated viewport prefetch after cache invalidation", async () => {
    function PrefetchAnchor() {
      return <a href="/target" data-testid="prefetch-target" />;
    }

    const result = await renderRoute(
      [{ path: "/", Component: PrefetchAnchor }],
      { request: "/", defaultPrefetch: "viewport" },
    );
    const target = result.getByTestId("prefetch-target");
    expect(observePrefetchElement).toHaveBeenCalledOnce();
    expect(observePrefetchElement).toHaveBeenCalledWith(target);

    result.router.store.markCacheAsStaleAndBroadcast();

    await vi.waitFor(() =>
      expect(observePrefetchElement).toHaveBeenCalledTimes(2),
    );
    expect(observePrefetchElement).toHaveBeenLastCalledWith(target);
  });

  it.each(["/café", "/caf%C3%A9", "/caf%c3%a9"])(
    "normalizes encoded basename spelling %s through the URL parser",
    async (basename) => {
      function EncodedTree() {
        return <a href="/caf%C3%A9/menu" data-testid="encoded-link" />;
      }

      const result = await renderRoute(
        [{ path: "/", Component: EncodedTree }],
        {
          request: "/",
          basename,
          defaultPrefetch: "viewport",
        },
      );

      expect(observePrefetchElement).toHaveBeenCalledWith(
        result.getByTestId("encoded-link"),
      );
    },
  );

  it("binds returned queries to document.body for portaled content", async () => {
    function PortalTree() {
      return (
        <>
          <main>Page content</main>
          {createPortal(<div role="dialog">Saved</div>, document.body)}
        </>
      );
    }

    const result = await renderRoute([{ path: "/", Component: PortalTree }], {
      request: "/",
    });

    expect(result.getByRole("dialog").textContent).toBe("Saved");
  });
});
