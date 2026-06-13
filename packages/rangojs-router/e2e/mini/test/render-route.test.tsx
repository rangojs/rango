// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { GlobalReverse, ParamReadout } from "../src/client.js";

afterEach(cleanup);

describe("renderRoute against mini client components", () => {
  it("ParamReadout reads route params via useParams()", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/products/:id", Component: ParamReadout }],
      { request: "/products/7" },
    );
    expect(getByTestId("param-id").textContent).toBe("7");
  });

  it("GlobalReverse resolves useReverse() over the generated global route map", async () => {
    // GlobalReverse uses useReverse(NamedRoutes) with full dotted GLOBAL names;
    // the global map's absolute paths pass through unchanged at the root mount.
    const { getByTestId } = await renderRoute(
      [{ path: "/", Component: GlobalReverse }],
      { request: "/" },
    );
    expect(getByTestId("global-reverse-home").textContent).toBe("/");
    expect(getByTestId("global-reverse-product").textContent).toBe(
      "/products/2",
    );
  });
});
