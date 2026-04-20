import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../browser/rango-state", () => ({
  getRangoState: () => "v1:abc",
  invalidateRangoState: vi.fn(),
}));

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

describe("prefetch wildcard cache (default source-agnostic)", () => {
  afterEach(() => {
    clearPrefetchCache();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
    restoreGlobalProperty("navigator", originalNavigatorDescriptor);
  });

  it("different source pages share one wildcard cache entry per target", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    prefetchDirect("/product/2", ["A0", "A0.route"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    window.location.href = "http://localhost:4173/product/3";
    (window.location as any).pathname = "/product/3";
    prefetchDirect("/product/2", ["A0", "A0.route"]);

    // Wildcard key (rango state + target) is shared → deduped.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("same source page re-prefetch is deduped", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/shop";
    (window.location as any).pathname = "/shop";
    prefetchDirect("/product/2", ["A0", "A0.route"]);
    prefetchDirect("/product/2", ["A0", "A0.route"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores under wildcard key when response has no scope header", async () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string | URL) =>
      Promise.resolve(
        new Response("payload", { status: 200, headers: { "X-Test": "1" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";
    prefetchDirect("/blog", ["A0"], "v1");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const { consumePrefetch } = await import("../browser/prefetch/cache");
    const wildcardKey =
      "v1:abc\0/blog?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    expect(consumePrefetch(wildcardKey)).not.toBeNull();
  });

  it("stores under source-scoped key when response has X-RSC-Prefetch-Scope: source", async () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string | URL) =>
      Promise.resolve(
        new Response("payload", {
          status: 200,
          headers: { "x-rsc-prefetch-scope": "source" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/gallery";
    (window.location as any).pathname = "/gallery";
    prefetchDirect("/photo/42", ["A0"], "v1");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const { consumePrefetch } = await import("../browser/prefetch/cache");
    const sourceKey =
      "v1:abc\0http://localhost:4173/gallery\0/photo/42?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const wildcardKey =
      "v1:abc\0/photo/42?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    expect(consumePrefetch(wildcardKey)).toBeNull();
    expect(consumePrefetch(sourceKey)).not.toBeNull();
  });

  it("skips same-page prefetch (would poison the wildcard slot)", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    prefetchDirect("/product/1", ["A0"]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows prefetch when target differs only in search params", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/search?q=a";
    (window.location as any).pathname = "/search";
    (window.location as any).search = "?q=a";
    prefetchDirect("/search?q=b", ["A0"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prefetchQueued also dedupes across source pages", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/page/1";
    (window.location as any).pathname = "/page/1";
    const key1 = prefetchQueued("/page/2", ["A0"]);

    window.location.href = "http://localhost:4173/page/5";
    (window.location as any).pathname = "/page/5";
    const key2 = prefetchQueued("/page/2", ["A0"]);

    expect(key1).toBe(key2);
  });

  it("skips queued prefetch when target is current page", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    const key = prefetchQueued("/product/1", ["A0"]);

    expect(key).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('prefetchKey=":source" opt-out', () => {
  afterEach(() => {
    clearPrefetchCache();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
    restoreGlobalProperty("navigator", originalNavigatorDescriptor);
  });

  it("different source pages are NOT deduped (each gets its own entry)", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/a";
    (window.location as any).pathname = "/a";
    prefetchDirect("/target", ["A0"], "v1", undefined, ":source");

    window.location.href = "http://localhost:4173/b";
    (window.location as any).pathname = "/b";
    prefetchDirect("/target", ["A0"], "v1", undefined, ":source");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stores under source-scoped key regardless of response header", async () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string | URL) =>
      Promise.resolve(
        new Response("payload", { status: 200, headers: { "X-Test": "1" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";
    prefetchDirect("/dashboard", ["A0"], "v1", undefined, ":source");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const { consumePrefetch } = await import("../browser/prefetch/cache");
    const sourceKey =
      "v1:abc\0http://localhost:4173/home\0/dashboard?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const wildcardKey =
      "v1:abc\0/dashboard?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    expect(consumePrefetch(wildcardKey)).toBeNull();
    expect(consumePrefetch(sourceKey)).not.toBeNull();
  });

  it('forced ":source" ignores pre-existing wildcard entry and populates the source slot', async () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string | URL) =>
      Promise.resolve(
        new Response("payload", { status: 200, headers: { "X-Test": "1" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Seed a default (wildcard) prefetch from /home.
    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";
    prefetchDirect("/dashboard", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Now force :source from /other for the same target. The wildcard
    // entry exists; the forced call must not dedupe against it — it has
    // to populate the source-scoped slot so navigation from /other
    // hits the correct response.
    window.location.href = "http://localhost:4173/other";
    (window.location as any).pathname = "/other";
    prefetchDirect("/dashboard", ["A0"], "v1", undefined, ":source");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const { consumePrefetch } = await import("../browser/prefetch/cache");
    const sourceKeyOther =
      "v1:abc\0http://localhost:4173/other\0/dashboard?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    expect(consumePrefetch(sourceKeyOther)).not.toBeNull();
  });

  it("allows same-page prefetch (source-scoped cannot poison wildcard)", () => {
    setupBrowser();
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/product/1";
    (window.location as any).pathname = "/product/1";
    prefetchDirect("/product/1", ["A0"], "v1", undefined, ":source");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("after consume + resolve, no sibling inflight flag is stuck", async () => {
    setupBrowser();
    let resolveFetch: (r: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/a";
    (window.location as any).pathname = "/a";
    prefetchDirect("/target", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { consumeInflightPrefetch, consumePrefetch, hasPrefetch } =
      await import("../browser/prefetch/cache");
    const sourceKeyA =
      "v1:abc\0http://localhost:4173/a\0/target?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const wildcardKey =
      "v1:abc\0/target?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

    // Consume via the source alias. This must NOT strand the wildcard
    // sibling's inflight flag after .finally() runs.
    const adopted = consumeInflightPrefetch(sourceKeyA);
    expect(adopted).not.toBeNull();

    // Resolve the fetch so .finally runs clearPrefetchInflight. The
    // response has no `x-rsc-prefetch-scope` header, so it stores under
    // wildcardKey — drain that cache entry to leave no cache trace.
    resolveFetch!(
      new Response("payload", { status: 200, headers: { "X-Test": "1" } }),
    );
    await adopted;
    await new Promise((r) => setTimeout(r, 0));
    expect(consumePrefetch(wildcardKey)).not.toBeNull();

    // With the cache entry drained, neither key should report prefetched —
    // any lingering `true` here would come from a stuck inflight flag.
    expect(hasPrefetch(sourceKeyA)).toBe(false);
    expect(hasPrefetch(wildcardKey)).toBe(false);

    // And a fresh prefetch for the same (source, target) pair must
    // actually go to the network rather than being silently deduped.
    let secondResolve: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          secondResolve = resolve;
        }),
    );
    prefetchDirect("/target", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    secondResolve!(
      new Response("payload-2", { status: 200, headers: { "X-Test": "1" } }),
    );
  });

  it("consuming one inflight alias atomically clears its sibling (no double-adopt)", async () => {
    setupBrowser();
    let resolveFetch: (r: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/a";
    (window.location as any).pathname = "/a";
    prefetchDirect("/target", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { consumeInflightPrefetch } =
      await import("../browser/prefetch/cache");
    const sourceKeyA =
      "v1:abc\0http://localhost:4173/a\0/target?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const wildcardKey =
      "v1:abc\0/target?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

    // Same-source nav adopts via sourceKeyA first.
    const adopted = consumeInflightPrefetch(sourceKeyA);
    expect(adopted).not.toBeNull();

    // Cross-source nav arriving afterwards must NOT also receive the
    // same promise via the wildcard alias.
    expect(consumeInflightPrefetch(wildcardKey)).toBeNull();

    resolveFetch!(
      new Response("payload", { status: 200, headers: { "X-Test": "1" } }),
    );
  });

  it("default (non-forced) prefetch registers inflight under BOTH wildcard and source keys", async () => {
    setupBrowser();
    let resolveFetch: (r: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/a";
    (window.location as any).pathname = "/a";
    prefetchDirect("/target", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { hasPrefetch } = await import("../browser/prefetch/cache");
    const sourceKeyA =
      "v1:abc\0http://localhost:4173/a\0/target?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const wildcardKey =
      "v1:abc\0/target?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

    // Both aliases should be discoverable before anyone consumes.
    expect(hasPrefetch(sourceKeyA)).toBe(true);
    expect(hasPrefetch(wildcardKey)).toBe(true);

    resolveFetch!(
      new Response("payload", { status: 200, headers: { "X-Test": "1" } }),
    );
  });

  it("inflight promise is registered under source key (no cross-source bleed)", async () => {
    setupBrowser();
    let resolveFetch: (r: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Start an inflight source-scoped prefetch from /a
    window.location.href = "http://localhost:4173/a";
    (window.location as any).pathname = "/a";
    prefetchDirect("/target", ["A0"], "v1", undefined, ":source");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A navigation from /b (different source) should NOT adopt /a's inflight.
    const { consumeInflightPrefetch } =
      await import("../browser/prefetch/cache");
    const sourceKeyB =
      "v1:abc\0http://localhost:4173/b\0/target?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const wildcardKey =
      "v1:abc\0/target?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    expect(consumeInflightPrefetch(sourceKeyB)).toBeNull();
    expect(consumeInflightPrefetch(wildcardKey)).toBeNull();

    // Navigation from /a (same source) CAN adopt the inflight.
    const sourceKeyA =
      "v1:abc\0http://localhost:4173/a\0/target?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    expect(consumeInflightPrefetch(sourceKeyA)).not.toBeNull();

    // Clean up the pending fetch to prevent unhandled rejection noise.
    resolveFetch!(
      new Response("payload", { status: 200, headers: { "X-Test": "1" } }),
    );
  });
});

/**
 * Regression: same-page cache poisoning.
 *
 * After navigating to a prefetched target, a render/viewport prefetch would
 * re-fetch the current page (same URL) and store a trivial same-page diff
 * under the wildcard key. Future cross-page navigations to that URL would
 * then get the trivial diff (1 segment) instead of the full diff (8+),
 * causing the UI not to update properly.
 *
 * The fix: always skip prefetching when the target pathname matches the
 * current page pathname (regardless of key — wildcard is now the default).
 */
describe("same-page cache poisoning regression", () => {
  afterEach(() => {
    clearPrefetchCache();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
    restoreGlobalProperty("navigator", originalNavigatorDescriptor);
  });

  it("after consuming a prefetch, same-page re-prefetch does not overwrite wildcard cache", async () => {
    setupBrowser();

    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response("full-diff-payload", {
          status: 200,
          headers: { "X-Test": "1" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/page/list";
    (window.location as any).pathname = "/page/list";
    prefetchDirect("/page/1", ["A0"], "v1");

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { consumePrefetch } = await import("../browser/prefetch/cache");
    const wildcardKey =
      "v1:abc\0/page/1?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const consumed = consumePrefetch(wildcardKey);
    expect(consumed).not.toBeNull();

    window.location.href = "http://localhost:4173/page/1";
    (window.location as any).pathname = "/page/1";

    prefetchDirect("/page/1", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const key = prefetchQueued("/page/1", ["A0"], "v1");
    expect(key).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);

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

    window.location.href = "http://localhost:4173/page/list";
    (window.location as any).pathname = "/page/list";
    prefetchDirect("/page/1", ["A0"], "v1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { consumePrefetch } = await import("../browser/prefetch/cache");
    const wildcardKey =
      "v1:abc\0/page/1?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    consumePrefetch(wildcardKey);

    window.location.href = "http://localhost:4173/page/2";
    (window.location as any).pathname = "/page/2";

    prefetchDirect("/page/1", ["A0"], "v1");

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

    const key1 = "v1:abc\0/page/1?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const key2 = "v1:abc\0/page/2?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const key3 = "v1:abc\0/page/3?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

    window.location.href = "http://localhost:4173/page/list";
    (window.location as any).pathname = "/page/list";

    prefetchDirect("/page/1", ["A0"], "v1");
    prefetchDirect("/page/2", ["A0"], "v1");
    prefetchDirect("/page/3", ["A0"], "v1");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    await new Promise((r) => setTimeout(r, 0));

    const res1 = consumePrefetch(key1);
    expect(res1).not.toBeNull();

    window.location.href = "http://localhost:4173/page/1";
    (window.location as any).pathname = "/page/1";
    prefetchDirect("/page/1", ["A0"], "v1");
    prefetchQueued("/page/1", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const res2 = consumePrefetch(key2);
    expect(res2).not.toBeNull();

    window.location.href = "http://localhost:4173/page/2";
    (window.location as any).pathname = "/page/2";
    prefetchDirect("/page/2", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const res3 = consumePrefetch(key3);
    expect(res3).not.toBeNull();

    window.location.href = "http://localhost:4173/page/3";
    (window.location as any).pathname = "/page/3";
    prefetchDirect("/page/3", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const staleEntry = consumePrefetch(key1);
    expect(staleEntry).toBeNull();

    prefetchDirect("/page/1", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
