import { describe, it, expect } from "vitest";
import { createElement } from "react";
import type { ResolvedSegment } from "../types";
import { getMemoizedContentPromise } from "../segment-content-promise";

function seg(overrides: Partial<ResolvedSegment>): ResolvedSegment {
  return {
    id: "R0",
    type: "route",
    index: 0,
    namespace: "",
    component: createElement("div", null, "body"),
    ...overrides,
  } as ResolvedSegment;
}

describe("getMemoizedContentPromise", () => {
  it("returns the component directly when it is already a Promise", () => {
    const componentPromise = Promise.resolve(createElement("div"));
    const segment = seg({ component: componentPromise });

    const result = getMemoizedContentPromise(segment, componentPromise);

    expect(result).toBe(componentPromise);
  });

  it("wraps a non-Promise component and caches the wrapper on the segment", () => {
    const component = createElement("div", null, "body");
    const segment = seg({ component });

    const first = getMemoizedContentPromise(segment, component);

    expect(first).toBeInstanceOf(Promise);
    expect(segment.contentPromise).toBe(first);
    expect(segment.contentSource).toBe(component);
  });

  it("returns the same wrapper when called again with the same component ref", () => {
    const component = createElement("div", null, "body");
    const segment = seg({ component });

    const first = getMemoizedContentPromise(segment, component);
    const second = getMemoizedContentPromise(segment, component);

    expect(second).toBe(first);
  });

  it("creates a new wrapper when the component ref changes", () => {
    const first = createElement("div", null, "first");
    const second = createElement("div", null, "second");
    const segment = seg({ component: first });

    const firstPromise = getMemoizedContentPromise(segment, first);
    const secondPromise = getMemoizedContentPromise(segment, second);

    expect(firstPromise).toBeInstanceOf(Promise);
    expect(secondPromise).toBeInstanceOf(Promise);
    expect(secondPromise).not.toBe(firstPromise);
    expect(segment.contentPromise).toBe(secondPromise);
    expect(segment.contentSource).toBe(second);
  });
});
