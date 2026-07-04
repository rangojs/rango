import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRangoStateSpy } = vi.hoisted(() => ({
  getRangoStateSpy: vi.fn(() => "v1:abc"),
}));

vi.mock("../browser/rango-state", () => ({
  getRangoState: getRangoStateSpy,
  invalidateRangoState: vi.fn(),
}));

import { prefetchDirect, setPrefetchDecoder } from "../browser/prefetch/fetch";
import { clearPrefetchCache } from "../browser/prefetch/cache";
import { resetPrefetchPolicy } from "../browser/prefetch/policy";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);

function setupBrowser(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        origin: "http://localhost:4173",
        href: "http://localhost:4173/current",
        pathname: "/current",
        search: "",
      },
      matchMedia: vi.fn(() => ({ matches: false, media: "" })),
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { connection: { saveData: false } },
  });
}

function restore(
  key: "window" | "navigator",
  desc: PropertyDescriptor | undefined,
): void {
  if (desc) {
    Object.defineProperty(globalThis, key, desc);
  } else {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

describe("prefetch reads rango state once per operation (B6)", () => {
  beforeEach(() => {
    setupBrowser();
    setPrefetchDecoder(vi.fn(() => Promise.resolve({})));
    getRangoStateSpy.mockClear();
  });

  afterEach(() => {
    clearPrefetchCache();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    restore("window", originalWindow);
    restore("navigator", originalNavigator);
  });

  it("prefetchDirect reads rango state exactly once and threads it into X-Rango-State", () => {
    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    prefetchDirect("/blog", ["segment.a"], "v1");

    // Previously read twice (once for the cache keys, once for the fetch header).
    // Now the single read is threaded through to the header.
    expect(getRangoStateSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["X-Rango-State"]).toBe("v1:abc");
  });
});
