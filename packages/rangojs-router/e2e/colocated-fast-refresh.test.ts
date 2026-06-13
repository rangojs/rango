import { expect, test } from "@playwright/test";
import { type Fixture, useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Render + hydration coverage for the colocated Fast Refresh fixture route
 * (/colocated-fr). The shared file ColocatedFrShared.tsx has no "use client"
 * directive yet lives in both the rsc graph (imported by the server route via
 * ColocatedFrServerNote) and the client graph (imported by the "use client"
 * island via ColocatedFrMarker) -- the shape vite-plugin-react#1248 addresses.
 *
 * The Fast Refresh contract itself is dev-only HMR behavior and lives in
 * client-component-hmr.test.ts. These tests pin that the same dual-graph,
 * non-"use client" file renders and hydrates correctly in BOTH dev and
 * production builds, so the structure the HMR guard depends on is exercised in
 * prod too.
 */

function defineRenderTests(f: Fixture) {
  test("renders server note + island marker and hydrates the counter", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/colocated-fr"));
    await waitForHydration(page);

    await expect(testId(page, "colocated-fr-title")).toHaveText(
      "Colocated Fast Refresh",
    );
    // rsc-graph export rendered server-side.
    await expect(testId(page, "colocated-fr-server-note")).toHaveText(
      "server-note",
    );
    // client-graph export rendered inside the island.
    await expect(testId(page, "colocated-fr-marker")).toHaveText(
      "marker-baseline",
    );

    // Island hydration: the counter responds to clicks.
    await testId(page, "colocated-fr-count").click();
    await expect(testId(page, "colocated-fr-count")).toHaveText("count: 1");
  });
}

test.describe("colocated-fast-refresh (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });
  defineRenderTests(f);
});

test.describe("colocated-fast-refresh (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });
  defineRenderTests(f);
});
