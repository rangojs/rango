// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { withLocationStateKey } from "@rangojs/router/testing";
import { renderRoute } from "@rangojs/router/testing/dom";
import { ActionLocationStateTest } from "../src/components/ActionLocationStateTest.js";
import { BreadcrumbNav } from "../src/components/BreadcrumbNav.js";
import { FeatureLoading } from "../src/components/FeatureLoading.js";
import { RouterPushStateTest } from "../src/components/RouterPushStateTest.js";
import {
  ActionFlash,
  ConcurrentSlotA,
  ConcurrentSlotB,
  FeatureLocationState,
  ListLocationState,
} from "../src/location-states.js";
import { Breadcrumbs } from "../src/handles/breadcrumbs.js";

afterEach(cleanup);

// No Vite plugin in this project, so definitions have no key: key the ones the
// components read without a seed (an unkeyed definition throws outside
// production). Seeded ones get a key from renderRoute's `locationState`.
withLocationStateKey(ActionFlash);
withLocationStateKey(ConcurrentSlotA);
withLocationStateKey(ConcurrentSlotB);
withLocationStateKey(ListLocationState, "ListLocationState");

// Dogfood renderRoute's location-state + handle seeding against cloudflare-basic's
// REAL client components. Unlike mini (built-in Breadcrumbs with a stable id),
// here `Breadcrumbs` is a LOCAL createHandle() and `ActionFlash` a local
// createLocationState() — both have empty plugin-injected ids in a bare test, so
// the by-reference seeding (which assigns synthetic ids / seeds by the handle id)
// is what makes them resolvable.
describe("renderRoute location-state seeding (cloudflare-basic)", () => {
  it("ActionLocationStateTest shows a seeded ActionFlash message", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/action-location-state", Component: ActionLocationStateTest }],
      {
        request: "/action-location-state",
        locationState: [[ActionFlash, { message: "saved-from-action" }]],
      },
    );
    expect(getByTestId("flash-message").textContent).toBe("saved-from-action");
  });

  it("falls back to 'none' when no ActionFlash is seeded", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/action-location-state", Component: ActionLocationStateTest }],
      { request: "/action-location-state" },
    );
    expect(getByTestId("flash-message").textContent).toBe("none");
  });

  it("FeatureLoading renders seeded FeatureLocationState (name + description)", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/features/:slug", Component: FeatureLoading }],
      {
        request: "/features/streaming",
        locationState: [
          [
            FeatureLocationState,
            { name: "Streaming", description: "Fast SSR" },
          ],
        ],
      },
    );
    expect(getByTestId("feature-loading-name").textContent).toBe("Streaming");
    expect(getByTestId("feature-loading-description").textContent).toBe(
      "Fast SSR",
    );
  });

  it("FeatureLoading shows the skeleton when no state is seeded", async () => {
    const { getByTestId, queryByTestId } = await renderRoute(
      [{ path: "/features/:slug", Component: FeatureLoading }],
      { request: "/features/streaming" },
    );
    expect(getByTestId("feature-loading-skeleton-name")).toBeTruthy();
    expect(queryByTestId("feature-loading-name")).toBeNull();
  });
});

// #993: router.push()/replace() with `[Def(value)]` reach useLocationState(Def)
// through renderRoute (production's history-state path).
describe("renderRoute typed state through router.push/replace (cloudflare-basic)", () => {
  it("RouterPushStateTest reads the list state it pushed, then replaced", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/action-location-state", Component: RouterPushStateTest }],
      { request: "/action-location-state" },
    );
    expect(getByTestId("list-state").textContent).toBe("none");

    fireEvent.click(getByTestId("list-push-btn"));
    await waitFor(() =>
      expect(getByTestId("list-state").textContent).toBe("pushed:20"),
    );
    expect(window.history.state).toMatchObject({
      __rsc_ls_ListLocationState: { label: "pushed", loaded: 20 },
    });

    fireEvent.click(getByTestId("list-replace-btn"));
    await waitFor(() =>
      expect(getByTestId("list-state").textContent).toBe("replaced:30"),
    );
  });
});

describe("renderRoute handle seeding (cloudflare-basic Breadcrumbs)", () => {
  it("BreadcrumbNav renders seeded breadcrumb items (local createHandle)", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/blog/:slug", Component: BreadcrumbNav }],
      {
        request: "/blog/hello",
        handles: [
          [
            Breadcrumbs,
            [
              { label: "Home", href: "/" },
              { label: "Blog", href: "/blog" },
            ],
          ],
        ],
      },
    );
    // Non-last crumbs render as links; the last as a span.
    expect(getByTestId("breadcrumb-link-home").textContent).toBe("Home");
    expect(getByTestId("breadcrumb-blog").textContent).toBe("Blog");
  });

  it("renders nothing when no breadcrumbs are seeded", async () => {
    const { container } = await renderRoute(
      [{ path: "/blog/:slug", Component: BreadcrumbNav }],
      { request: "/blog/hello" },
    );
    expect(container.querySelector("[data-testid='breadcrumbs']")).toBeNull();
  });
});
