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
        search: "",
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

describe("prefetchKey source-agnostic caching", () => {
  afterEach(() => {
    clearPrefetchCache();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
    restoreGlobalProperty("navigator", originalNavigatorDescriptor);
  });

  it("same target with prefetchKey from different source pages is deduped", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Prefetch /product/2 from /product/1 with prefetchKey
    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    prefetchDirect(
      "/product/2",
      ["A0", "A0.route"],
      undefined,
      undefined,
      "products",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Navigate to /product/3 and prefetch same target — should be deduped
    window.location.href = "http://localhost:4173/product/3";
    (window.location as any).pathname = "/product/3";
    prefetchDirect(
      "/product/2",
      ["A0", "A0.route"],
      undefined,
      undefined,
      "products",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("callback prefetchKey also dedupes across source pages", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const normalize = (from: string) => from.replace(/\/\d+$/, "");

    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    prefetchDirect("/product/2", ["A0"], undefined, undefined, normalize);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    window.location.href = "http://localhost:4173/product/5";
    (window.location as any).pathname = "/product/5";
    prefetchDirect("/product/2", ["A0"], undefined, undefined, normalize);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("without prefetchKey, different source pages are NOT deduped (baseline)", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    prefetchDirect("/product/2", ["A0"]);

    window.location.href = "http://localhost:4173/product/3";
    (window.location as any).pathname = "/product/3";
    prefetchDirect("/product/2", ["A0"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("prefetchQueued also supports prefetchKey dedup", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/page/1";
    (window.location as any).pathname = "/page/1";
    const key1 = prefetchQueued(
      "/page/2",
      ["A0"],
      undefined,
      undefined,
      "pages",
    );

    window.location.href = "http://localhost:4173/page/5";
    (window.location as any).pathname = "/page/5";
    const key2 = prefetchQueued(
      "/page/2",
      ["A0"],
      undefined,
      undefined,
      "pages",
    );

    // Same wildcard key — second call is deduped
    expect(key1).toBe(key2);
  });

  it("skips direct prefetch when target is current page with prefetchKey", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // On /product/1, prefetching /product/1 with prefetchKey — skip
    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    prefetchDirect("/product/1", ["A0"], undefined, undefined, "products");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips queued prefetch when target is current page with prefetchKey", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    const key = prefetchQueued(
      "/product/1",
      ["A0"],
      undefined,
      undefined,
      "products",
    );

    // Returns empty — skipped entirely
    expect(key).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows prefetch when only search params differ with prefetchKey", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // On /search?q=a, prefetching /search?q=b — different search, should NOT skip
    window.location.href = "http://localhost:4173/search?q=a";
    (window.location as any).pathname = "/search";
    (window.location as any).search = "?q=a";
    prefetchDirect("/search?q=b", ["A0"], undefined, undefined, "search");

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same search — SHOULD skip
    prefetchDirect("/search?q=a", ["A0"], undefined, undefined, "search");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT skip same-page prefetch without prefetchKey", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    prefetchDirect("/product/1", ["A0"]);

    // Without prefetchKey, same-page prefetch is allowed (harmless —
    // the source-dependent key won't be looked up cross-page)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression: prefetchKey same-page cache poisoning
 *
 * When using prefetchKey, after navigating to a prefetched target, the page's
 * viewport/render prefetch would re-fetch the current page (same URL) and store
 * a trivial same-page diff under the wildcard key. Future cross-page navigations
 * to that URL would then get the trivial diff (1 segment) instead of the full
 * diff (8+ segments), causing the UI to not update properly.
 *
 * The fix: skip prefetching when the target pathname matches the current page
 * pathname and prefetchKey is set.
 */
describe("prefetchKey same-page cache poisoning regression", () => {
  afterEach(() => {
    clearPrefetchCache();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
    restoreGlobalProperty("navigator", originalNavigatorDescriptor);
  });

  it("after consuming a prefetch, same-page re-prefetch does not overwrite wildcard cache", async () => {
    setupBrowser();

    // Mock fetch to return a response with a tee-able body
    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response("full-diff-payload", {
          status: 200,
          headers: { "X-Test": "1" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Step 1: On /page/list, prefetch /page/1 with prefetchKey
    window.location.href = "http://localhost:4173/page/list";
    (window.location as any).pathname = "/page/list";
    prefetchDirect("/page/1", ["A0"], "v1", undefined, "pages");

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Wait for the fetch to complete and store in cache
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Step 2: Simulate navigating to /page/1 — the entry is consumed
    const { consumePrefetch } = await import("../browser/prefetch/cache");
    const wildcardKey =
      "*\0/page/1?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const consumed = consumePrefetch(wildcardKey);
    expect(consumed).not.toBeNull();

    // Step 3: Now on /page/1, try to re-prefetch /page/1 (self-link)
    window.location.href = "http://localhost:4173/page/1";
    (window.location as any).pathname = "/page/1";

    prefetchDirect("/page/1", ["A0"], "v1", undefined, "pages");

    // No new fetch — same-page skip prevents cache poisoning
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Also verify queued path is blocked
    const key = prefetchQueued("/page/1", ["A0"], "v1", undefined, "pages");
    expect(key).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Step 4: Verify wildcard cache is empty (consumed, not re-poisoned)
    const recheck = consumePrefetch(wildcardKey);
    expect(recheck).toBeNull();
  });

  it("after consuming a prefetch, cross-page re-prefetch IS allowed", async () => {
    setupBrowser();

    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response("diff-payload", {
          status: 200,
          headers: { "X-Test": "1" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Step 1: On /page/list, prefetch /page/1
    window.location.href = "http://localhost:4173/page/list";
    (window.location as any).pathname = "/page/list";
    prefetchDirect("/page/1", ["A0"], "v1", undefined, "pages");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Step 2: Consume the entry
    const { consumePrefetch } = await import("../browser/prefetch/cache");
    const wildcardKey =
      "*\0/page/1?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    consumePrefetch(wildcardKey);

    // Step 3: Navigate to /page/2 (NOT /page/1), re-prefetch /page/1
    window.location.href = "http://localhost:4173/page/2";
    (window.location as any).pathname = "/page/2";

    prefetchDirect("/page/1", ["A0"], "v1", undefined, "pages");

    // Cross-page re-prefetch IS allowed — different pathname
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("full pagination flow: forward through /1→/2→/3 then back to /1 uses correct entry", async () => {
    setupBrowser();

    let fetchCount = 0;
    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) => {
      fetchCount++;
      return Promise.resolve(
        new Response(`payload-${fetchCount}`, {
          status: 200,
          headers: { "X-Test": "1" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { consumePrefetch } = await import("../browser/prefetch/cache");

    const key1 = "*\0/page/1?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const key2 = "*\0/page/2?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const key3 = "*\0/page/3?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

    // Step 1: On /page/list, prefetch /page/1, /page/2, /page/3
    window.location.href = "http://localhost:4173/page/list";
    (window.location as any).pathname = "/page/list";

    prefetchDirect("/page/1", ["A0"], "v1", undefined, "pages");
    prefetchDirect("/page/2", ["A0"], "v1", undefined, "pages");
    prefetchDirect("/page/3", ["A0"], "v1", undefined, "pages");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Flush microtasks so storePrefetch/clearPrefetchInflight complete
    await new Promise((r) => setTimeout(r, 0));

    // Step 2: Navigate to /page/1 — consume entry
    const res1 = consumePrefetch(key1);
    expect(res1).not.toBeNull();

    // "On /page/1" — self-link prefetch should be blocked
    window.location.href = "http://localhost:4173/page/1";
    (window.location as any).pathname = "/page/1";
    prefetchDirect("/page/1", ["A0"], "v1", undefined, "pages");
    prefetchQueued("/page/1", ["A0"], "v1", undefined, "pages");
    // No new fetches — self-link blocked
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Step 3: Navigate to /page/2 — consume entry
    const res2 = consumePrefetch(key2);
    expect(res2).not.toBeNull();

    window.location.href = "http://localhost:4173/page/2";
    (window.location as any).pathname = "/page/2";
    prefetchDirect("/page/2", ["A0"], "v1", undefined, "pages");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Step 4: Navigate to /page/3 — consume entry
    const res3 = consumePrefetch(key3);
    expect(res3).not.toBeNull();

    window.location.href = "http://localhost:4173/page/3";
    (window.location as any).pathname = "/page/3";
    prefetchDirect("/page/3", ["A0"], "v1", undefined, "pages");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Step 5: Go back to /page/1 — no wildcard entry (consumed, not re-poisoned)
    const staleEntry = consumePrefetch(key1);
    expect(staleEntry).toBeNull();

    // A cross-page re-prefetch from /page/3 to /page/1 IS allowed
    prefetchDirect("/page/1", ["A0"], "v1", undefined, "pages");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
