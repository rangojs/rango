// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  createLocationState,
  Link,
  useLocationState,
  useRouter,
} from "../../client.js";
import { renderRoute } from "../dom.entry.js";
import { withLocationStateKey } from "../index.js";

afterEach(cleanup);

// Userland contract for #993: a unit test keys a definition with
// withLocationStateKey (no Vite plugin), and a push/replace with
// `[Def(value)]` reaches useLocationState(Def) through renderRoute, which
// writes the state with production's history-state path.
const GridState = withLocationStateKey(
  createLocationState<{ count: number }>(),
  "GridState",
);

function Grid() {
  const router = useRouter();
  const grid = useLocationState(GridState);
  return (
    <div>
      <p data-testid="count">{grid?.count ?? "none"}</p>
      <button
        data-testid="more"
        onClick={() =>
          router.push("/grid?page=2", {
            state: [GridState({ count: (grid?.count ?? 0) + 3 })],
          })
        }
      />
      <button
        data-testid="reset"
        onClick={() =>
          router.replace("/grid", { state: [GridState({ count: 0 })] })
        }
      />
      <button data-testid="plain" onClick={() => router.push("/grid?p=1")} />
      <Link
        to="/grid?from=link"
        state={[GridState(() => ({ count: 9 }))]}
        data-testid="link"
      >
        link
      </Link>
    </div>
  );
}

describe("renderRoute: typed location state through push/replace", () => {
  it("useLocationState(Def) reads the value pushed with [Def(value)]", async () => {
    const { getByTestId, router } = await renderRoute(
      [{ path: "/grid", Component: Grid }],
      { request: "/grid" },
    );
    const count = () => getByTestId("count").textContent;
    expect(count()).toBe("none");
    const idx = window.history.state?.idx ?? 0;

    fireEvent.click(getByTestId("more"));
    await waitFor(() => expect(count()).toBe("3"));
    expect(router.pathname()).toBe("/grid");
    expect(window.history.state).toMatchObject({
      __rsc_ls_GridState: { count: 3 },
      idx: idx + 1,
    });

    fireEvent.click(getByTestId("reset"));
    await waitFor(() => expect(count()).toBe("0"));
    expect(window.history.state).toMatchObject({
      __rsc_ls_GridState: { count: 0 },
      idx: idx + 1,
    });
  });

  it("<Link state> writes through the same path; a push without state clears it", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/grid", Component: Grid }],
      { request: "/grid" },
    );
    const count = () => getByTestId("count").textContent;

    fireEvent.click(getByTestId("link"));
    await waitFor(() => expect(count()).toBe("9"));

    fireEvent.click(getByTestId("plain"));
    await waitFor(() => expect(count()).toBe("none"));
    expect(window.history.state).not.toHaveProperty("__rsc_ls_GridState");
  });

  it("seeds and pushes under the same key", async () => {
    const { getByTestId } = await renderRoute(
      [{ path: "/grid", Component: Grid }],
      { request: "/grid", locationState: [[GridState, { count: 5 }]] },
    );
    const count = () => getByTestId("count").textContent;
    expect(count()).toBe("5");
    fireEvent.click(getByTestId("more"));
    await waitFor(() => expect(count()).toBe("8"));
  });
});
