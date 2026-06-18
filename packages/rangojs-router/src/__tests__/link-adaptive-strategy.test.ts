import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAdaptiveStrategy } from "../browser/react/Link.js";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

function restoreWindow(): void {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).window;
  }
}

/**
 * Install a window whose matchMedia("(hover: none)") result is driven by the
 * mutable `hoverNone` flag, so a test can flip touch capability between calls.
 */
function installWindow(getHoverNone: () => boolean): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      matchMedia: vi.fn((query: string) => ({
        matches: query === "(hover: none)" ? getHoverNone() : false,
        media: query,
      })),
    },
  });
}

describe("resolveAdaptiveStrategy (F5)", () => {
  afterEach(() => {
    restoreWindow();
    vi.restoreAllMocks();
  });

  it("passes non-adaptive strategies through unchanged", () => {
    installWindow(() => true);
    expect(resolveAdaptiveStrategy("hover")).toBe("hover");
    expect(resolveAdaptiveStrategy("viewport")).toBe("viewport");
    expect(resolveAdaptiveStrategy("render")).toBe("render");
    expect(resolveAdaptiveStrategy("none")).toBe("none");
  });

  it("resolves adaptive to hover on a pointer (hover-capable) device", () => {
    installWindow(() => false);
    expect(resolveAdaptiveStrategy("adaptive")).toBe("hover");
  });

  it("resolves adaptive to viewport on a touch (no-hover) device", () => {
    installWindow(() => true);
    expect(resolveAdaptiveStrategy("adaptive")).toBe("viewport");
  });

  /**
   * The core F5 regression: the touch capability is read at the point of use,
   * not captured once at module load. If the input capability flips (hybrid
   * device gaining/losing a pointer, or SSR -> hydrate), a later call must
   * reflect the CURRENT value. A module-load snapshot would freeze the first
   * value and return the same strategy on the second call.
   */
  it("reflects the current touch capability, not a module-load snapshot", () => {
    let hoverNone = false; // start as a pointer device
    installWindow(() => hoverNone);

    // First evaluation: pointer device -> hover.
    expect(resolveAdaptiveStrategy("adaptive")).toBe("hover");

    // Capability flips to touch (e.g. keyboard/mouse detached).
    hoverNone = true;

    // Second evaluation must reflect the new capability -> viewport.
    expect(resolveAdaptiveStrategy("adaptive")).toBe("viewport");
  });

  it("returns a stable hover default when window is undefined (SSR guard)", () => {
    restoreWindow();
    delete (globalThis as Record<string, unknown>).window;
    expect(resolveAdaptiveStrategy("adaptive")).toBe("hover");
  });
});
