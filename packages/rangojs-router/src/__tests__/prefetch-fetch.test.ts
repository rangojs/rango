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
        pathname: "/current",
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

  it("prefetches with _rsc_segments and current page as client path", () => {
    setupBrowser({ saveData: false, reducedData: false });
    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    prefetchDirect("/blog", ["segment.a"], "v1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchedUrl = fetchMock.mock.calls[0]![0].toString();
    expect(fetchedUrl).toContain(
      "/blog?_rsc_partial=true&_rsc_segments=segment.a&_rsc_v=v1",
    );

    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["X-RSC-Router-Client-Path"]).toBe(
      "http://localhost:4173/current",
    );
    expect(headers["X-Rango-Prefetch"]).toBe("1");
  });

  it("stores response in in-memory cache on success", async () => {
    setupBrowser({ saveData: false, reducedData: false });
    const body = "rsc-payload-data";
    const fetchMock = vi.fn((_url: string | URL) =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { "X-Test": "1" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    prefetchDirect("/blog", [], "v1");

    // Wait for the async fetch + buffer to complete
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("prefetch dedup source-page context", () => {
  afterEach(() => {
    clearPrefetchCache();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
    restoreGlobalProperty("navigator", originalNavigatorDescriptor);
  });

  it("same target from different source pages is not suppressed", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Prefetch /product/2 from /product/1
    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    prefetchDirect("/product/2", ["A0", "A0.route"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate navigation to /product/3
    window.location.href = "http://localhost:4173/product/3";
    (window.location as any).pathname = "/product/3";

    // Prefetch /product/2 again — different source page, should NOT be deduped
    prefetchDirect("/product/2", ["A0", "A0.route"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("same target from same source page is deduped", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Prefetch /product/2 from /shop
    window.location.href = "http://localhost:4173/shop";
    (window.location as any).pathname = "/shop";
    prefetchDirect("/product/2", ["A0", "A0.route"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Prefetch /product/2 from /shop again — same source, should be deduped
    prefetchDirect("/product/2", ["A0", "A0.route"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
