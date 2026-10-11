import { describe, expect, it, vi } from "vitest";
import { runRevalidate } from "../index.js";
import type { RevalidateParams, ShouldRevalidateFn } from "../../types.js";

const ACTION_ID = "src/actions/cart.ts#addToCart";
const addToCart = Object.assign(() => {}, { $id: ACTION_ID });
const removeFromCart = Object.assign(() => {}, {
  $id: "src/actions/cart.ts#removeFromCart",
});

describe("runRevalidate (public testing primitive)", () => {
  it("runs isAction(ref) through the production matcher", async () => {
    const predicate: ShouldRevalidateFn = ({ isAction }) => isAction(addToCart);

    expect(await runRevalidate(predicate, { action: addToCart })).toBe(true);
    expect(await runRevalidate(predicate, { action: removeFromCart })).toBe(
      false,
    );
    expect(await runRevalidate(predicate, { action: ACTION_ID })).toBe(true);
    expect(await runRevalidate(predicate)).toBe(false);
  });

  it("passes the urls() arguments: actionResult, formData, actionUrl, method, route names", async () => {
    const seen: RevalidateParams[] = [];
    const form = new FormData();
    form.set("qty", "2");
    await runRevalidate(
      (args) => {
        seen.push(args);
      },
      {
        currentUrl: "/cart?tab=a",
        nextUrl: "/cart?tab=b",
        currentParams: { id: "1" },
        action: { ref: addToCart, result: { ok: true }, formData: form },
        routeName: "cart",
        fromRouteName: "home",
        stale: true,
      },
    );
    expect(seen[0]).toMatchObject({
      actionId: ACTION_ID,
      actionResult: { ok: true },
      method: "POST",
      segmentType: "loader",
      currentParams: { id: "1" },
      nextParams: { id: "1" },
      routeName: "cart",
      toRouteName: "cart",
      fromRouteName: "home",
      stale: true,
      defaultShouldRevalidate: true,
    });
    expect(seen[0].formData?.get("qty")).toBe("2");
    expect(seen[0].actionUrl?.href).toBe("http://localhost/cart?tab=a");
    expect(seen[0].nextUrl.search).toBe("?tab=b");
  });

  it("seeds context with vars and env, or takes a context", async () => {
    const readFlag: ShouldRevalidateFn = ({ context }) =>
      context.get("flag" as never) === "on";
    expect(await runRevalidate(readFlag, { vars: { flag: "on" } })).toBe(true);
    expect(await runRevalidate(readFlag)).toBe(false);
    expect(
      await runRevalidate(({ context }) => context.env.MODE === "test", {
        env: { MODE: "test" },
      }),
    ).toBe(true);
    const context = { get: () => "on" } as never;
    expect(await runRevalidate(readFlag, { context })).toBe(true);
  });

  it("applies the router's default decisions", async () => {
    const defer: ShouldRevalidateFn = () => undefined;
    // A navigation that changes nothing keeps the segment.
    expect(await runRevalidate(defer)).toBe(false);
    // A route's loader re-runs when params or search change.
    expect(
      await runRevalidate(defer, {
        currentParams: { id: "1" },
        nextParams: { id: "2" },
      }),
    ).toBe(true);
    expect(
      await runRevalidate(defer, { currentUrl: "/a", nextUrl: "/a?x=1" }),
    ).toBe(true);
    // A layout's loader does not.
    expect(
      await runRevalidate(defer, {
        currentParams: { id: "1" },
        nextParams: { id: "2" },
        belongsToRoute: false,
      }),
    ).toBe(false);
    // An action re-runs a loader.
    expect(await runRevalidate(defer, { action: addToCart })).toBe(true);
    expect(await runRevalidate(defer, { method: "POST" })).toBe(true);
  });

  it("threads soft verdicts and stops at a boolean", async () => {
    expect(
      await runRevalidate([
        () => ({ defaultShouldRevalidate: true }),
        ({ defaultShouldRevalidate }) => defaultShouldRevalidate,
      ]),
    ).toBe(true);
    let secondRan = false;
    expect(
      await runRevalidate([
        () => false,
        () => {
          secondRan = true;
          return true;
        },
      ]),
    ).toBe(false);
    expect(secondRan).toBe(false);
  });

  it("fails open to the default when a predicate throws, and rethrows a Response", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await runRevalidate(
        () => {
          throw new Error("boom");
        },
        { action: addToCart },
      ),
    ).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();

    await expect(
      runRevalidate(() => {
        throw new Response(null, {
          status: 302,
          headers: { location: "/login" },
        });
      }),
    ).rejects.toBeInstanceOf(Response);
  });

  it("rejects an action reference that carries no id, loudly", async () => {
    await expect(
      runRevalidate(({ isAction }) => isAction(), { action: () => {} }),
    ).rejects.toThrow(/no \$id\/\$\$id/);
  });
});
