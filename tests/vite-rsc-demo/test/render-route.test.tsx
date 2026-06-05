// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { CartBadge } from "../src/components/CartBadge.js";
import { CartLoader } from "../src/handlers/shop/loaders/cart.js";
import { LoadingSpinner } from "../src/handlers/shop/components/loading.js";

afterEach(cleanup);

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
      { initialUrl: "/shop", loaders: [[CartLoader, cart]] },
    );
    expect(container.textContent).toContain("(3)"); // itemCount in badge text
    expect(getByTitle("Total: $89.97")).toBeTruthy(); // total in title attr
  });

  it("LoadingSpinner reads useNavigation and shows no spinner at idle", async () => {
    const { container } = await renderRoute(
      [{ path: "/shop", Component: LoadingSpinner }],
      { initialUrl: "/shop" },
    );
    expect(container.textContent).not.toContain("Loading...");
    expect(container.textContent).not.toContain("Streaming...");
  });
});
