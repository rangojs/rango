import { describe, expect, it } from "vitest";
import { runClientRevalidate } from "../index.js";
import type { ClientRevalidateFn } from "../../client-urls/types.js";

const ACTION_ID = "src/actions/cart.ts#addToCart";
const addToCart = Object.assign(() => {}, { $id: ACTION_ID });
const removeFromCart = Object.assign(() => {}, {
  $id: "src/actions/cart.ts#removeFromCart",
});

describe("runClientRevalidate (public testing primitive)", () => {
  it("runs isAction(ref) through the production matcher", () => {
    const predicate: ClientRevalidateFn = ({ isAction }) => isAction(addToCart);

    expect(runClientRevalidate(predicate, { action: addToCart })).toBe(true);
    expect(runClientRevalidate(predicate, { action: removeFromCart })).toBe(
      false,
    );
    expect(runClientRevalidate(predicate, { action: ACTION_ID })).toBe(true);
    expect(runClientRevalidate(predicate)).toBe(false);
  });

  it("bare isAction() is true for any action and false on navigation", () => {
    const anyAction: ClientRevalidateFn = ({ isAction }) => isAction();
    expect(runClientRevalidate(anyAction, { action: addToCart })).toBe(true);
    expect(runClientRevalidate(anyAction)).toBe(false);
  });

  it("honors { defaultShouldRevalidate } and defers on void", () => {
    expect(
      runClientRevalidate(() => ({ defaultShouldRevalidate: false }), {
        action: addToCart,
      }),
    ).toBe(false);
    expect(runClientRevalidate(() => undefined, { action: addToCart })).toBe(
      true,
    );
  });

  it("mirrors the server chain: soft verdicts thread, booleans short-circuit", () => {
    // Soft verdict feeds the NEXT predicate's defaultShouldRevalidate.
    expect(
      runClientRevalidate([
        () => ({ defaultShouldRevalidate: true }),
        ({ defaultShouldRevalidate }) => defaultShouldRevalidate,
      ]),
    ).toBe(true);
    // A boolean is a hard decision: later predicates never run.
    let secondRan = false;
    expect(
      runClientRevalidate([
        () => false,
        () => {
          secondRan = true;
          return true;
        },
      ]),
    ).toBe(false);
    expect(secondRan).toBe(false);
  });

  it("ignores a non-boolean object verdict (would invert the wire encoding)", () => {
    expect(
      runClientRevalidate(
        // Untyped JS consumers can return anything.
        () => ({ defaultShouldRevalidate: "no" }) as never,
        { action: addToCart },
      ),
    ).toBe(true);
  });

  it("models an action-triggered refetch GET: isAction() true, nav default", () => {
    const args: { isActionResult?: boolean; def?: boolean } = {};
    runClientRevalidate(
      ({ isAction, defaultShouldRevalidate }) => {
        args.isActionResult = isAction(addToCart);
        args.def = defaultShouldRevalidate;
        return undefined;
      },
      { action: addToCart, actionRequest: false },
    );
    expect(args.isActionResult).toBe(true);
    // Same-URL refetch: the server applies navigation defaults (false).
    expect(args.def).toBe(false);
  });

  it("rejects an action reference that carries no id, loudly", () => {
    expect(() =>
      runClientRevalidate(({ isAction }) => isAction(), { action: () => {} }),
    ).toThrow(/no \$id\/\$\$id/);
  });
});
