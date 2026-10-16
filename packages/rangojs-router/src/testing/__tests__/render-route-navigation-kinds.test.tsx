// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useNavigation } from "../../browser/react/use-navigation.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";

// Consumer contract (hook lock rows S9, I3, G1, LD5): useNavigation() reports
// `loading` for a navigation AND a server action; `isNavigating` is true for a
// navigation only, so a progress bar can ignore actions; useLoader().isLoading
// covers navigations and load(), never an action on its own.

const CountLoader = {
  __brand: "loader",
} as unknown as LoaderDefinition<number>;

function Probe(): ReactNode {
  const nav = useNavigation();
  const { data, isLoading } = useLoader(CountLoader);
  return (
    <p data-testid="probe">
      {`${nav.state} navigating=${nav.isNavigating} streaming=${nav.isStreaming} loader=${data} isLoading=${isLoading}`}
    </p>
  );
}

afterEach(cleanup);

async function mount() {
  const result = await renderRoute([{ path: "/items", Component: Probe }], {
    request: "/items",
    loaders: [[CountLoader, 1]],
  });
  const read = () => result.getByTestId("probe").textContent;
  return { ...result, read };
}

describe("renderRoute: useNavigation() navigation versus server action", () => {
  it("idle reports isNavigating false", async () => {
    const { read } = await mount();
    expect(read()).toBe(
      "idle navigating=false streaming=false loader=1 isLoading=false",
    );
  });

  it("a navigation in flight reports loading with isNavigating true", async () => {
    const { read, router } = await mount();
    let handle!: ReturnType<typeof router.eventController.startNavigation>;
    await act(async () => {
      handle = router.eventController.startNavigation("/items?page=2");
    });
    await waitFor(() =>
      expect(read()).toBe(
        "loading navigating=true streaming=true loader=1 isLoading=false",
      ),
    );
    await act(async () => {
      handle[Symbol.dispose]();
    });
    await waitFor(() => expect(read()).toMatch(/^idle navigating=false/));
  });

  it("a server action reports loading with isNavigating false and the loader isLoading false", async () => {
    const { read, router } = await mount();
    let action!: ReturnType<typeof router.eventController.startAction>;
    await act(async () => {
      action = router.eventController.startAction("src/actions.ts#save", []);
    });
    await waitFor(() =>
      expect(read()).toBe(
        "loading navigating=false streaming=true loader=1 isLoading=false",
      ),
    );
    await act(async () => {
      action.complete(undefined);
    });
  });
});
