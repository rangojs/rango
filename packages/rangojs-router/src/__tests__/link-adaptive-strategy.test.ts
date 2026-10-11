import { afterEach, describe, expect, it, vi } from "vitest";

import type { resolveAdaptiveStrategy as ResolveAdaptiveStrategy } from "../browser/react/Link.js";

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
 * Install a window whose matchMedia("(hover: none)") returns a MediaQueryList
 * whose `.matches` is a LIVE getter driven by the mutable `getHoverNone` flag —
 * modelling the real browser object shared prefetch strategy resolution caches
 * once and re-reads for Links and delegated anchors.
 * Returns the matchMedia spy so a test can assert the query is created once.
 */
function installWindow(getHoverNone: () => boolean): ReturnType<typeof vi.fn> {
  const matchMedia = vi.fn((query: string) => ({
    media: query,
    get matches() {
      return query === "(hover: none)" ? getHoverNone() : false;
    },
  }));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { matchMedia },
  });
  return matchMedia;
}

// Each test re-imports the module fresh (resetModules) after stubbing matchMedia.
async function freshResolve(): Promise<typeof ResolveAdaptiveStrategy> {
  vi.resetModules();
  const mod = await import("../browser/react/Link.js");
  return mod.resolveAdaptiveStrategy;
}

describe("resolveAdaptiveStrategy (F5)", () => {
  afterEach(() => {
    restoreWindow();
    vi.restoreAllMocks();
  });

  it("passes non-adaptive strategies through unchanged", async () => {
    installWindow(() => true);
    const resolveAdaptiveStrategy = await freshResolve();
    expect(resolveAdaptiveStrategy("hover")).toBe("hover");
    expect(resolveAdaptiveStrategy("viewport")).toBe("viewport");
    expect(resolveAdaptiveStrategy("render")).toBe("render");
    expect(resolveAdaptiveStrategy("none")).toBe("none");
  });

  it("resolves adaptive to hover on a pointer (hover-capable) device", async () => {
    installWindow(() => false);
    const resolveAdaptiveStrategy = await freshResolve();
    expect(resolveAdaptiveStrategy("adaptive")).toBe("hover");
  });

  it("resolves adaptive to viewport on a touch (no-hover) device", async () => {
    installWindow(() => true);
    const resolveAdaptiveStrategy = await freshResolve();
    expect(resolveAdaptiveStrategy("adaptive")).toBe("viewport");
  });

  /**
   * The core F5 regression: touch capability is read at the point of use, not
   * captured once, so a capability flip (hybrid device) is reflected.
   */
  it("reflects a live capability flip", async () => {
    let hoverNone = false; // start as a pointer device
    installWindow(() => hoverNone);
    const resolveAdaptiveStrategy = await freshResolve();

    // First evaluation: pointer device -> hover.
    expect(resolveAdaptiveStrategy("adaptive")).toBe("hover");

    // Capability flips to touch (e.g. keyboard/mouse detached).
    hoverNone = true;

    // Resolved when a prefetch is armed or triggered, never during render, so
    // each resolve reads the current capability.
    expect(resolveAdaptiveStrategy("adaptive")).toBe("viewport");
  });

  it("returns a stable hover default when window is undefined (SSR guard)", async () => {
    const resolveAdaptiveStrategy = await freshResolve();
    restoreWindow();
    delete (globalThis as Record<string, unknown>).window;
    expect(resolveAdaptiveStrategy("adaptive")).toBe("hover");
  });
});
