// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { Link } from "@rangojs/router/client";
import { CRClientNav } from "../src/components/CRClientNav.js";

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
    const active = new Set<Element>();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = (element: Element) => active.add(element);
        unobserve = (element: Element) => active.delete(element);
        disconnect = vi.fn();
      },
    );
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

    expect(active.has(getByTestId("pricing-link"))).toBe(true);
    expect(active.has(getByTestId("docs-link"))).toBe(true);

    cleanup();
    configure({ reactStrictMode: false });
    expect(active.size).toBe(0);

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

    expect(active.has(first.getByTestId("first-link"))).toBe(true);
    expect(active.has(second.getByTestId("second-link"))).toBe(false);
  });

  it("uses the IntersectionObserver stub installed for the current test", async () => {
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = observe;
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );

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

    expect(observe).toHaveBeenCalledWith(result.getByTestId("current-link"));
    expect(observe).not.toHaveBeenCalledWith(result.getByTestId("asset-link"));
    expect(observe).toHaveBeenCalledWith(
      result.getByTestId("resource-route-link"),
    );
    expect(observe).not.toHaveBeenCalledWith(result.getByTestId("none-link"));
    expect(observe).not.toHaveBeenCalledWith(
      result.getByTestId("sibling-link"),
    );
    expect(observe).not.toHaveBeenCalledWith(result.getByTestId("svg-link"));
  });
});
