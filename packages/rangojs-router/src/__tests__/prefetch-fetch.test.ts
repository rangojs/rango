import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefetchDirect, prefetchQueued } from "../browser/prefetch/fetch";
import { clearPrefetchCache } from "../browser/prefetch/cache";
import { resetPrefetchPolicy } from "../browser/prefetch/policy";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);

function restoreGlobalProperty(
  key: "window" | "navigator",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>)[key];
}

function createMediaQueryList(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(prefers-reduced-data: reduce)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  } as MediaQueryList;
}

function setupBrowser({
  saveData = false,
  reducedData = false,
}: {
  saveData?: boolean;
  reducedData?: boolean;
} = {}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        origin: "http://localhost:4173",
        href: "http://localhost:4173/current",
      },
      matchMedia: vi.fn(() => createMediaQueryList(reducedData)),
    },
  });

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      connection: { saveData },
    },
  });
}

describe("prefetch fetch reduced-data behavior", () => {
  beforeEach(() => {
    setupBrowser();
  });

  afterEach(() => {
    clearPrefetchCache();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
    restoreGlobalProperty("navigator", originalNavigatorDescriptor);
  });

  it("skips direct prefetch when save-data is enabled", () => {
    setupBrowser({ saveData: true });
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    prefetchDirect("/blog", ["segment.a"], "v1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips direct prefetch when prefers-reduced-data is set", () => {
    setupBrowser({ reducedData: true });
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    prefetchDirect("/blog", ["segment.a"], "v1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips queued prefetch when save-data is enabled", () => {
    setupBrowser({ saveData: true });
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    prefetchQueued("/blog", ["segment.a"], "v1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips queued prefetch when prefers-reduced-data is set", () => {
    setupBrowser({ reducedData: true });
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    prefetchQueued("/blog", ["segment.a"], "v1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefetches when reduced-data preferences are not set", () => {
    setupBrowser({ saveData: false, reducedData: false });
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    prefetchDirect("/blog", ["segment.a"], "v1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain(
      "/blog?_rsc_partial=true&_rsc_segments=segment.a&_rsc_v=v1",
    );
  });
});
