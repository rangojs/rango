/**
 * revalidate(true) / revalidate(false): the urls() helper stores the
 * constant predicate the boolean stands for, so every evaluation path
 * (segments, loaders, intercept loaders, parallels) sees a function.
 */
import { describe, it, expect } from "vitest";
import type { LoaderEntry } from "../../server/context.js";
import { loader, revalidate } from "../dsl-helpers.js";
import { toShouldRevalidateFn } from "../../router/revalidation.js";
import type { LoaderDefinition, ShouldRevalidateFn } from "../../types.js";
import { runRevalidate } from "../../testing/run-revalidate.js";
import { parentEntry, withDslStore } from "./dsl-test-helpers.js";

const def = {
  __brand: "loader",
  $$id: "test#Loader",
  fn: async () => "data",
} as unknown as LoaderDefinition<any>;

const ACTION = { action: "src/actions.ts#save" };

describe("revalidate(true | false)", () => {
  it("stores the constant predicate on the segment, in declaration order", async () => {
    const parent = parentEntry();
    const custom: ShouldRevalidateFn = () => undefined;
    withDslStore(parent, () => {
      revalidate(true);
      revalidate(custom);
      revalidate(false);
    });
    const [always, kept, never] = parent.revalidate;
    expect(kept).toBe(custom);
    expect(typeof always).toBe("function");
    expect(typeof never).toBe("function");
    expect(always).toBe(toShouldRevalidateFn(true));
    expect(never).toBe(toShouldRevalidateFn(false));
    // Same answers as revalidate(() => true) / revalidate(() => false).
    expect(await runRevalidate(always)).toBe(true);
    expect(await runRevalidate(never, ACTION)).toBe(false);
  });

  it("stores it on a loader's use() entry", async () => {
    const parent = parentEntry();
    withDslStore(parent, () => {
      loader(def, () => [revalidate(false)]);
      loader(def, () => [revalidate(true)]);
    });
    const [held, rerun] = parent.loader as LoaderEntry[];
    expect(held.revalidate).toEqual([toShouldRevalidateFn(false)]);
    expect(rerun.revalidate).toEqual([toShouldRevalidateFn(true)]);
    // A same-URL navigation (the route-owned default holds) and an action
    // (the default re-runs).
    expect(await runRevalidate(rerun.revalidate)).toBe(true);
    expect(await runRevalidate(held.revalidate, ACTION)).toBe(false);
  });

  it("rejects an argument that is neither a predicate nor a boolean", () => {
    for (const [value, got] of [
      [undefined, "undefined"],
      [null, "null"],
      ["true", "string"],
      [{ defaultShouldRevalidate: true }, "object"],
    ] as const) {
      expect(() =>
        withDslStore(parentEntry(), () => revalidate(value as never)),
      ).toThrow(`revalidate() expects a predicate or a boolean, got ${got}`);
    }
  });
});

describe("toShouldRevalidateFn", () => {
  it("returns a predicate as is and a boolean as its constant predicate", () => {
    const fn: ShouldRevalidateFn = () => undefined;
    expect(toShouldRevalidateFn(fn)).toBe(fn);
    expect(toShouldRevalidateFn(true)({} as never)).toBe(true);
    expect(toShouldRevalidateFn(false)({} as never)).toBe(false);
  });
});

describe("runRevalidate takes what revalidate() takes", () => {
  it("a boolean, alone or in a chain", async () => {
    expect(await runRevalidate(true)).toBe(true);
    expect(await runRevalidate(false, ACTION)).toBe(false);
    // A soft suggestion, then a hard false.
    expect(
      await runRevalidate(
        [() => ({ defaultShouldRevalidate: true }), false],
        ACTION,
      ),
    ).toBe(false);
    // A defer, then a hard true where the default holds.
    expect(await runRevalidate([() => undefined, true])).toBe(true);
  });
});
