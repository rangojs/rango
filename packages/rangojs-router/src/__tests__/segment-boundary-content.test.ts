// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { getBoundaryContent } from "../segment-boundary-content";

// Why a node and not a promise in the browser: see the header of
// segment-boundary-content.ts.
describe("getBoundaryContent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("returns a component that is already a Promise as is", () => {
    const componentPromise = Promise.resolve(createElement("div"));

    expect(getBoundaryContent(componentPromise)).toBe(componentPromise);
  });

  it("returns any other component as is in the browser", () => {
    const component = createElement("div", null, "body");

    expect(getBoundaryContent(component)).toBe(component);
    expect(getBoundaryContent("hello")).toBe("hello");
    expect(getBoundaryContent(null)).toBe(null);
  });

  it("wraps a component in a fresh Promise per call on the server", async () => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);
    const server = await import("../segment-boundary-content");
    const component = createElement("div", null, "body");

    const first = server.getBoundaryContent(component);
    const second = server.getBoundaryContent(component);

    expect(first).toBeInstanceOf(Promise);
    expect(second).not.toBe(first);
    await expect(first as Promise<unknown>).resolves.toBe(component);
  });
});
