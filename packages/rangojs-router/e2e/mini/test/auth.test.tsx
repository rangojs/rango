// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { FlashBanner } from "../src/client.js";
import { FlashMessage } from "../src/shared.js";

afterEach(cleanup);

// The /login route (router.tsx) uses INLINE server actions (function-level
// "use server" in the handler) that `throw redirect("/login", { state })` — login
// stays on /login, which then shows the signed-in state plus the flash. Those
// inline action closures can't be unit-tested through the public primitives: the
// test harness has no "use server" transform, so renderHandler produces no usable
// tree for a route embedding an inline action, and the closures aren't importable.
// That action path is e2e-territory (mini has no Playwright e2e). What we CAN pin
// here is the visible outcome — FlashBanner rendering the welcome flash the action
// sets via the thrown redirect's { state } — seeded by reference.
describe("mini login flash display", () => {
  it("FlashBanner renders the welcome message on /login", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/login", Component: FlashBanner }],
      {
        request: "/login",
        locationState: [[FlashMessage, { text: "Welcome back, Alice!" }]],
      },
    );
    expect(getByTestId("flash").textContent).toBe("Welcome back, Alice!");
  });
});
