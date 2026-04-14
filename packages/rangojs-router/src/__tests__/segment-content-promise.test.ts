// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { getMemoizedContentPromise } from "../segment-content-promise";

describe("getMemoizedContentPromise", () => {
  it("returns the component directly when it is already a Promise", () => {
    const componentPromise = Promise.resolve(createElement("div"));

    const result = getMemoizedContentPromise(componentPromise);

    expect(result).toBe(componentPromise);
  });

  it("wraps a non-Promise component in a Promise", () => {
    const component = createElement("div", null, "body");

    const first = getMemoizedContentPromise(component);

    expect(first).toBeInstanceOf(Promise);
  });

  it("returns the same wrapper when called again with the same component ref", () => {
    const component = createElement("div", null, "body");

    const first = getMemoizedContentPromise(component);
    const second = getMemoizedContentPromise(component);

    expect(second).toBe(first);
  });

  it("creates a new wrapper when the component ref changes", () => {
    const first = createElement("div", null, "first");
    const second = createElement("div", null, "second");

    const firstPromise = getMemoizedContentPromise(first);
    const secondPromise = getMemoizedContentPromise(second);

    expect(firstPromise).toBeInstanceOf(Promise);
    expect(secondPromise).toBeInstanceOf(Promise);
    expect(secondPromise).not.toBe(firstPromise);
  });

  it("memoizes across independent callers sharing a component ref", () => {
    const component = createElement("div", null, "shared");

    const a = getMemoizedContentPromise(component);
    const b = getMemoizedContentPromise(component);

    expect(a).toBe(b);
  });

  it("memoizes primitive components (strings, null) via the fallback cache", () => {
    // Partial-update flows render text/null-backed segments; a fresh
    // Promise.resolve per render would reintroduce the Suspense flicker
    // this memoization exists to prevent.
    const stringFirst = getMemoizedContentPromise("hello");
    const stringSecond = getMemoizedContentPromise("hello");
    const nullFirst = getMemoizedContentPromise(null);
    const nullSecond = getMemoizedContentPromise(null);

    expect(stringSecond).toBe(stringFirst);
    expect(nullSecond).toBe(nullFirst);
    expect(stringFirst).not.toBe(nullFirst);
  });

  it("returns distinct wrappers for different primitive values", () => {
    const a = getMemoizedContentPromise("a");
    const b = getMemoizedContentPromise("b");

    expect(a).not.toBe(b);
  });
});
