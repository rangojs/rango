// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";
import { useAction } from "../../browser/react/use-action.js";
import { renderRoute } from "../render-route.js";

// Hook lock row A3 (dc-t84): "If the same action fires several times, the
// hook reports the latest call" (skills/hooks/handle-and-actions.md). Two
// calls of one action, the later one settling first: the AddToCart reader
// shows the later call's result when it returns, and the earlier call
// settling afterwards changes nothing the hook reports.
//
// renderRoute runs no server action (its fidelity contract), so these tests
// drive the action lifecycle through router.eventController, the controller
// the server-action bridge drives (startAction, startStreaming, complete,
// fail). The browser proof is e2e/action-latest-call.test.ts in the router
// test-app and tests/cloudflare-basic.

const ADD_TO_CART = "src/cart.ts#addToCart";
/** The function form: an imported "use server" export carries its $$id. */
const addToCart = Object.assign(async () => undefined, { $$id: ADD_TO_CART });

type Frame = { shown: string; pending: boolean; error: string | null };
let frames: Frame[] = [];

/** The AddToCart shape, read through the full state and two selectors. */
function AddToCart(): ReactNode {
  const { state, result } = useAction(addToCart);
  const pending = useAction("addToCart", (s) => s.state !== "idle");
  const error = useAction(addToCart, (s) =>
    s.error instanceof Error ? s.error.message : null,
  );
  const shown =
    state === "idle"
      ? ((result as { name?: string } | null)?.name ?? "")
      : "Adding…";
  useLayoutEffect(() => {
    frames.push({ shown, pending, error });
  });
  return <p data-testid="cart">{shown}</p>;
}

afterEach(cleanup);

const settleWindow = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 150)));

/** Consecutive duplicates dropped: what the reader shows, frame by frame. */
const distinct = <T,>(values: T[]): T[] =>
  values.filter((value, i) => i === 0 || values[i - 1] !== value);

async function mountWithTwoCalls() {
  const result = await renderRoute([{ path: "/cart", Component: AddToCart }], {
    request: "/cart",
  });
  frames = [];
  const { eventController } = result.router;
  let first!: ReturnType<typeof eventController.startAction>;
  let second!: ReturnType<typeof eventController.startAction>;
  await act(async () => {
    first = eventController.startAction(ADD_TO_CART, ["first"]);
  });
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  await act(async () => {
    second = eventController.startAction(ADD_TO_CART, ["second"]);
  });
  await waitFor(() =>
    expect(result.getByTestId("cart").textContent).toBe("Adding…"),
  );
  return { ...result, first, second };
}

describe("renderRoute: useAction() reports the latest call", () => {
  it("the later call settling first shows its result; the earlier call never shows", async () => {
    const { getByTestId, first, second } = await mountWithTwoCalls();

    await act(async () => {
      second.complete({ name: "second" });
    });
    await waitFor(() => expect(getByTestId("cart").textContent).toBe("second"));
    // The later call's settle window ends while the earlier call still runs.
    await settleWindow();

    await act(async () => {
      first.startStreaming().end();
      first.complete({ name: "first" });
    });
    await settleWindow();

    expect(distinct(frames.map((f) => f.shown))).toEqual([
      "Adding…",
      "second",
      "",
    ]);
    expect(distinct(frames.map((f) => f.pending))).toEqual([true, false]);
    expect(frames.every((f) => f.error === null)).toBe(true);
  });

  it("an earlier call that fails after the later one succeeded reports no error", async () => {
    const { getByTestId, first, second } = await mountWithTwoCalls();

    await act(async () => {
      second.complete({ name: "second" });
    });
    await waitFor(() => expect(getByTestId("cart").textContent).toBe("second"));
    await act(async () => {
      first.fail(new Error("out of stock"));
    });
    await settleWindow();

    expect(distinct(frames.map((f) => f.shown))).toEqual([
      "Adding…",
      "second",
      "",
    ]);
    expect(frames.every((f) => f.error === null)).toBe(true);
  });

  it("the later call failing shows its error, never the earlier call's result", async () => {
    const { getByTestId, first, second } = await mountWithTwoCalls();

    await act(async () => {
      second.fail(new Error("out of stock"));
    });
    await waitFor(() => expect(getByTestId("cart").textContent).toBe(""));
    await act(async () => {
      first.complete({ name: "first" });
    });
    await settleWindow();

    expect(distinct(frames.map((f) => f.shown))).toEqual(["Adding…", ""]);
    expect(distinct(frames.map((f) => f.error))).toEqual([
      null,
      "out of stock",
      null,
    ]);
  });
});
