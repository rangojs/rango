// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { getMemoizedContentPromise } from "../segment-content-promise";

describe("getMemoizedContentPromise", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("returns the component directly when it is already a Promise", () => {
    const componentPromise = Promise.resolve(createElement("div"));

    const result = getMemoizedContentPromise(componentPromise);

    expect(result).toBe(componentPromise);
  });

  // Not a promise: React knows a resolved promise as fulfilled only once it
  // has read it, and a boundary on screen handed one it has not read, in a
  // render that cannot wait, shows its loading() fallback again.
  it("returns a non-Promise component as is in the browser", () => {
    const component = createElement("div", null, "body");

    expect(getMemoizedContentPromise(component)).toBe(component);
    expect(getMemoizedContentPromise("hello")).toBe("hello");
    expect(getMemoizedContentPromise(null)).toBe(null);
  });

  it("wraps a non-Promise component in a fresh Promise on the server", async () => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);
    const server = await import("../segment-content-promise");
    const component = createElement("div", null, "body");

    const first = server.getMemoizedContentPromise(component);
    const second = server.getMemoizedContentPromise(component);

    expect(first).toBeInstanceOf(Promise);
    expect(second).toBeInstanceOf(Promise);
    expect(second).not.toBe(first);
    await expect(first as Promise<unknown>).resolves.toBe(component);
  });
});
