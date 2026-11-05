import { describe, expect, it } from "vitest";
import { shallowEqual } from "../browser/react/shallow-equal.js";

// The equality every selector-based hook uses to decide whether its value
// moved (useNavigation, useParams, useHandle, useAction, and
// route-content-wrapper's error/reset pair). Plain objects and arrays compare
// by their own enumerable keys; everything else by identity, so a `URL`,
// `URLSearchParams`, `Date` or `Map` — no own enumerable keys between them —
// is never called equal to a different instance.

describe("shallowEqual", () => {
  it("compares primitives with Object.is", () => {
    expect(shallowEqual(1, 1)).toBe(true);
    expect(shallowEqual(1, 2)).toBe(false);
    expect(shallowEqual(NaN, NaN)).toBe(true);
    expect(shallowEqual(0, -0)).toBe(false);
    expect(shallowEqual("a", "a")).toBe(true);
    expect(shallowEqual(undefined, null)).toBe(false);
  });

  it("compares plain objects by their own enumerable keys", () => {
    expect(shallowEqual({ id: "1" }, { id: "1" })).toBe(true);
    expect(shallowEqual({ id: "1" }, { id: "2" })).toBe(false);
    expect(shallowEqual({ id: "1" }, { id: "1", extra: true })).toBe(false);
    expect(shallowEqual({ id: "1" }, {})).toBe(false);
    // A key the prototype chain would answer is not the object's own.
    expect(shallowEqual<object>({}, { toString: 1 })).toBe(false);
  });

  it("compares arrays by their own keys", () => {
    expect(shallowEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(shallowEqual(["a", "b"], ["a", "c"])).toBe(false);
    expect(shallowEqual(["a"], ["a", "b"])).toBe(false);
    expect(shallowEqual([], [])).toBe(true);
  });

  it("does not call an array and a plain object with the same keys equal", () => {
    expect(shallowEqual(["a"], { 0: "a" } as unknown as string[])).toBe(false);
  });

  it("compares a class instance by identity, never by its (empty) keys", () => {
    const url = new URL("https://example.com/a");
    expect(shallowEqual(url, url)).toBe(true);
    expect(shallowEqual(url, new URL("https://example.com/a"))).toBe(false);
    expect(
      shallowEqual(new URLSearchParams("a=1"), new URLSearchParams("a=1")),
    ).toBe(false);
    expect(shallowEqual(new Date(0), new Date(0))).toBe(false);
    expect(shallowEqual(new Map(), new Map())).toBe(false);
    expect(shallowEqual(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(false);
  });

  it("compares a class instance inside a plain object by identity", () => {
    const url = new URL("https://example.com/a");
    expect(shallowEqual({ url }, { url })).toBe(true);
    expect(shallowEqual({ url }, { url: new URL(url.href) })).toBe(false);
  });

  it("compares a null-prototype object by its keys", () => {
    const a = Object.assign(Object.create(null), { id: "1" });
    const b = Object.assign(Object.create(null), { id: "1" });
    expect(shallowEqual(a, b)).toBe(true);
    expect(shallowEqual(a, { id: "1" })).toBe(true);
  });

  it("does not descend: a nested object compares by identity", () => {
    expect(shallowEqual({ nested: { a: 1 } }, { nested: { a: 1 } })).toBe(
      false,
    );
    const nested = { a: 1 };
    expect(shallowEqual({ nested }, { nested })).toBe(true);
  });
});
