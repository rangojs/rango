// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { CartBadge } from "../src/components/CartBadge.js";
import { CartLoader } from "../src/handlers/shop/loaders/cart.js";
import { LoadingSpinner } from "../src/handlers/shop/components/loading.js";
import { BreadcrumbNav } from "../src/components/BreadcrumbNav.js";
import { Breadcrumbs } from "../src/handles/breadcrumbs.js";

afterEach(cleanup);

describe("renderRoute handle seeding (vite-rsc-demo BreadcrumbNav)", () => {
  it("renders seeded breadcrumb items via useHandle(Breadcrumbs)", async () => {
    const { container } = await renderRoute(
      [{ path: "/shop/product/:slug", Component: BreadcrumbNav }],
      {
        request: "/shop/product/headphones",
        handles: [
          [
            Breadcrumbs,
            [
              { label: "Shop", href: "/shop" },
              { label: "Headphones", href: "/shop/product/headphones" },
            ],
          ],
        ],
      },
    );
    const nav = container.querySelector('nav[aria-label="Breadcrumb"]');
    expect(nav).not.toBeNull();
    expect(nav?.textContent).toContain("Shop");
    expect(nav?.textContent).toContain("Headphones");
  });

  it("renders nothing when no breadcrumbs are seeded", async () => {
    const { container } = await renderRoute(
      [{ path: "/shop/product/:slug", Component: BreadcrumbNav }],
      { request: "/shop/product/headphones" },
    );
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull();
  });
});

describe("renderRoute against vite-rsc-demo client components", () => {
  // The REAL CartBadge reads useLoader(CartLoader). Seed by REFERENCE via the
  // `loaders` option (renderRoute assigns a synthetic id for the real loader's
  // empty $$id, so useLoader resolves). Previously this crashed.
  it("CartBadge renders seeded CartLoader data (itemCount + total)", async () => {
    const cart = {
      items: [{ productId: "yoga-mat", quantity: 3, price: 29.99 }],
      total: 89.97,
      itemCount: 3,
    };
    const { getByTitle, container } = await renderRoute(
      [{ path: "/shop", Component: CartBadge }],
      { request: "/shop", loaders: [[CartLoader, cart]] },
    );
    expect(container.textContent).toContain("(3)"); // itemCount in badge text
    expect(getByTitle("Total: $89.97")).toBeTruthy(); // total in title attr
  });

  it("LoadingSpinner reads useNavigation and shows no spinner at idle", async () => {
    const { container } = await renderRoute(
      [{ path: "/shop", Component: LoadingSpinner }],
      { request: "/shop" },
    );
    // renderRoute cannot seed a non-idle navigation state (loading/streaming),
    // so only the idle branch is observable here — the loading/streaming
    // rendering is covered by e2e. Pin the idle contract POSITIVELY: the
    // component must have mounted (read useNavigation without throwing) and
    // rendered its reserved-space wrapper with NO spinner spans. Asserting only
    // the absence of "Loading..."/"Streaming..." would pass even if the
    // component had crashed and rendered nothing.
    const wrapper = container.querySelector("div");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelectorAll("span").length).toBe(0);
    expect(container.textContent).not.toContain("Loading...");
    expect(container.textContent).not.toContain("Streaming...");
  });
});
