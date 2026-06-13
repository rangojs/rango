// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { FlashBanner, OriginReadout } from "../src/client.js";
import { FlashMessage, Origin } from "../src/shared.js";

afterEach(cleanup);

// Dogfood renderRoute's location-state seeding against mini's REAL components.
// FlashBanner reads useLocationState(FlashMessage); OriginReadout reads
// useLocationState(Origin). Both location-state defs have an empty injected key
// in a bare test, so we seed BY REFERENCE via the `locationState` option.
describe("renderRoute location-state seeding (mini)", () => {
  it("OriginReadout reads a seeded persistent location-state value", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/state", Component: OriginReadout }],
      { request: "/state", locationState: [[Origin, { from: "checkout" }]] },
    );
    expect(getByTestId("origin").textContent).toBe("checkout");
  });

  it("renders the empty fallback when no location state is seeded", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/state", Component: OriginReadout }],
      { request: "/state" },
    );
    expect(getByTestId("origin").textContent).toBe("no-origin");
  });

  it("FlashBanner reads a seeded flash message", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/state", Component: FlashBanner }],
      {
        request: "/state",
        locationState: [[FlashMessage, { text: "Saved!" }]],
      },
    );
    expect(getByTestId("flash").textContent).toBe("Saved!");
  });

  it("seeds multiple location states at once", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/state", Component: OriginReadout }],
      {
        request: "/state",
        locationState: [
          [Origin, { from: "home" }],
          [FlashMessage, { text: "hi" }],
        ],
      },
    );
    expect(getByTestId("origin").textContent).toBe("home");
  });
});
