// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { CRClientNav } from "../src/components/CRClientNav.js";

afterEach(cleanup);

describe("renderRoute against cloudflare-basic client components", () => {
  // CRClientNav is a REAL "use client" component reading router context:
  // useParams() + useReverse(crRoutes) + <Link>. renderRoute mounts it in the
  // router's NavigationProvider with a synthetic segment tree (client-tree
  // fidelity only: no server render, no Flight, loaders seeded not run).
  it("reads route params via useParams()", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/cr/:tenantId/posts/:postId", Component: CRClientNav }],
      { initialUrl: "/cr/acme/posts/p1" },
    );
    expect(getByTestId("cr-cf-tenant").textContent).toBe("acme");
  });

  it("resolves useReverse() against the component's route map", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/cr/:tenantId/posts/:postId", Component: CRClientNav }],
      { initialUrl: "/cr/acme/posts/p1" },
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
      { initialUrl: "/cr/acme/posts/p1" },
    );
    expect(getByTestId("cr-cf-tenant").textContent).toBe("acme");
    await router.navigate("/cr/zeta/posts/p9");
    expect(router.params()).toMatchObject({ tenantId: "zeta", postId: "p9" });
    expect(getByTestId("cr-cf-tenant").textContent).toBe("zeta");
  });
});
