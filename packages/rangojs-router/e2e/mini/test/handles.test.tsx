// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { Breadcrumbs } from "@rangojs/router";
import { renderRoute } from "@rangojs/router/testing/dom";
import { BreadcrumbTrail } from "../src/client.js";

afterEach(cleanup);

// Dogfood renderRoute's handle seeding against mini's REAL BreadcrumbTrail, which
// reads useHandle(Breadcrumbs). Built-in handles have a stable id, so seeding by
// reference via `handles` works directly.
describe("renderRoute handle seeding (mini Breadcrumbs)", () => {
  it("BreadcrumbTrail renders seeded breadcrumb handle data", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/products/:id", Component: BreadcrumbTrail }],
      {
        request: "/products/2",
        handles: [
          [
            Breadcrumbs,
            [
              { label: "Home", href: "/" },
              { label: "Products", href: "/products" },
              { label: "Item 2", href: "/products/2" },
            ],
          ],
        ],
      },
    );
    expect(getByTestId("crumb-0").textContent).toContain("Home");
    expect(getByTestId("crumb-1").textContent).toContain("Products");
    expect(getByTestId("crumb-2").textContent).toContain("Item 2");
  });

  it("renders an empty trail when no handle data is seeded", async () => {
    const { queryByTestId } = await renderRoute(
      [{ path: "/products/:id", Component: BreadcrumbTrail }],
      { request: "/products/2" },
    );
    expect(queryByTestId("crumb-0")).toBeNull();
  });
});
