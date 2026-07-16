import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../browser/rango-state", () => ({
  getRangoState: () => "v1:abc",
  invalidateRangoState: vi.fn(),
}));

import {
  prefetchDirect,
  prefetchQueued,
  setPrefetchDecoder,
} from "../browser/prefetch/fetch";
import { clearPrefetchCache, consumePrefetch } from "../browser/prefetch/cache";
import { resetPrefetchPolicy } from "../browser/prefetch/policy";
import { abortAllPrefetches } from "../browser/prefetch/queue";
import { enterActionFence, __resetActionFence } from "../browser/action-fence";

// Prefetch eagerly decodes the fetched response (createFromFetch) to warm the
// route's client chunks. The cache stores the decoded entry, not the raw
// Response. This mock stands in for that decode; tests assert it runs once at
// prefetch time and is reused (not re-run) on navigation.
const decodeMock = vi.fn(() => Promise.resolve({} as Record<string, unknown>));

beforeEach(() => {
  decodeMock.mockClear();
  setPrefetchDecoder(decodeMock);
});

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
    abortAllPrefetches();
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
    expect(headers["X-Rango-Fragment-Passthrough"]).toBe("1");
  });

  it("stores the decoded entry in the in-memory cache on success", async () => {
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

  it("eagerly decodes the prefetched response once and reuses it (warms chunks)", async () => {
    setupBrowser({ saveData: false, reducedData: false });
    const fetchMock = vi.fn((_url: string | URL) =>
      Promise.resolve(
        new Response("payload", { status: 200, headers: { "X-Test": "1" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";
    prefetchDirect("/blog", ["A0"], "v1");

    // The decode runs at PREFETCH time — this is what imports the route's
    // client chunks before any click.
    await vi.waitFor(() => expect(decodeMock).toHaveBeenCalledTimes(1));

    const { consumePrefetch } = await import("../browser/prefetch/cache");
    const wildcardKey =
      "v1:abc\0/blog?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";
    const entry = consumePrefetch(wildcardKey);
    expect(entry).not.toBeNull();

    // Navigation reuses the already-decoded payload — no second decode.
    expect(await entry!.payload).toEqual({});
    expect(decodeMock).toHaveBeenCalledTimes(1);
  });

  it("does not warm (or decode) a response carrying a control header", async () => {
    setupBrowser({ saveData: false, reducedData: false });
    const fetchMock = vi.fn((_url: string | URL) =>
      Promise.resolve(
        new Response("payload", {
          status: 200,
          headers: { "X-RSC-Reload": "http://localhost:4173/" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";
    prefetchDirect("/blog", ["A0"], "v1");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Speculative prefetch must not act on the control header — and must not
    // cache a stale/redirecting response. Navigation re-fetches to honor it.
    expect(decodeMock).not.toHaveBeenCalled();
    const { consumePrefetch } = await import("../browser/prefetch/cache");
    expect(
      consumePrefetch(
        "v1:abc\0/blog?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1",
      ),
    ).toBeNull();
  });

  it("does not warm (or decode) a response whose router id does not match", async () => {
    setupBrowser({ saveData: false, reducedData: false });
    const fetchMock = vi.fn((_url: string | URL) =>
      Promise.resolve(
        new Response("payload", {
          status: 200,
          headers: { "X-RSC-Router-Id": "other-app" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";
    // This client is router "client-app"; the response belongs to "other-app"
    // (a stale/edge-cache or proxy mix-up). The foreign payload must be dropped
    // before decode — never warmed, no chunks imported.
    prefetchDirect("/blog", ["A0"], "v1", "client-app");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(decodeMock).not.toHaveBeenCalled();
  });
});

describe("prefetch wildcard cache (default source-agnostic)", () => {
  afterEach(() => {
    clearPrefetchCache();
    abortAllPrefetches();
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
    abortAllPrefetches();
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

    // Resolve the fetch so .finally runs clearPrefetchInflight. The response
    // has no `x-rsc-prefetch-scope` header, so it would store under wildcardKey
    // — but because the in-flight promise was adopted, storePrefetch must NOT
    // publish the now-owned (single-use) entry to the cache. A leftover here is
    // exactly the bug that drops a route's handles on a later navigation served
    // the drained entry.
    resolveFetch!(
      new Response("payload", { status: 200, headers: { "X-Test": "1" } }),
    );
    await adopted;
    await new Promise((r) => setTimeout(r, 0));
    expect(consumePrefetch(wildcardKey)).toBeNull();

    // No cache entry was published and no inflight flag is stuck — neither key
    // reports prefetched after an adopted+resolved fetch.
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

describe("prefetch fetch options (credentials + action fence)", () => {
  beforeEach(() => {
    setupBrowser();
    __resetActionFence();
  });

  afterEach(() => {
    clearPrefetchCache();
    abortAllPrefetches();
    resetPrefetchPolicy();
    __resetActionFence();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
    restoreGlobalProperty("navigator", originalNavigatorDescriptor);
  });

  function prefetchInit(): RequestInit {
    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: false, body: null } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    prefetchDirect("/blog", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return fetchMock.mock.calls[0]![1]!;
  }

  it("does not set credentials to omit (the rango-state Set-Cookie must apply)", () => {
    const init = prefetchInit();
    expect(init.credentials).toBeUndefined();
  });

  it("uses cache:no-store while an action fence is active", () => {
    // Bypass the Vary-keyed HTTP cache so a prefetch during an action's flight
    // fetches fresh rather than warming the map with soon-to-be-stale bytes.
    enterActionFence();
    const init = prefetchInit();
    expect(init.cache).toBe("no-store");
  });

  it("does not override the cache mode when no action fence is active", () => {
    const init = prefetchInit();
    expect(init.cache).toBeUndefined();
  });
});

/**
 * F4: a hover/direct prefetch fetches with no caller AbortSignal. If the server
 * stalls and the fetch never settles, the inflight key was stranded forever:
 * `hasPrefetch(key)` stayed true, so every future prefetch of that URL was
 * silently deduped out (no warming) until a full cache clear. An internal
 * timeout now aborts the stalled fetch so it settles, the `.finally()` clears
 * the inflight flag, and the URL can be prefetched again.
 */
describe("hover prefetch stalled-fetch timeout (F4)", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearPrefetchCache();
    abortAllPrefetches();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
    restoreGlobalProperty("navigator", originalNavigatorDescriptor);
  });

  it("aborts a never-settling direct prefetch so the key can be prefetched again", async () => {
    vi.useFakeTimers();
    setupBrowser();

    // A fetch that resolves only when its AbortSignal fires (i.e. a stalled
    // server). Without the internal timeout, this never settles and strands
    // the inflight key.
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          sig.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";

    const { hasPrefetch } = await import("../browser/prefetch/cache");
    const wildcardKey =
      "v1:abc\0/blog?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

    prefetchDirect("/blog", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Inflight while the fetch is pending.
    expect(hasPrefetch(wildcardKey)).toBe(true);

    // A re-prefetch while still inflight is correctly deduped (no new fetch).
    prefetchDirect("/blog", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past the internal timeout: the stalled fetch is aborted and
    // settles, running the `.finally()` cleanup.
    await vi.advanceTimersByTimeAsync(31_000);

    // The inflight key is released — no longer stranded.
    expect(hasPrefetch(wildcardKey)).toBe(false);

    // A fresh prefetch of the same URL now actually hits the network again
    // instead of being silently deduped against the dead inflight entry.
    prefetchDirect("/blog", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("evicts a published entry whose body stalls AFTER headers, so it can be re-prefetched", async () => {
    vi.useFakeTimers();
    setupBrowser();

    // Headers arrive (the fetch resolves and the entry publishes), but the body
    // NEVER produces or closes — a server that flushes headers then stalls
    // mid-stream. A never-resolving `pull()` makes the tracking tee read hang, so
    // streamComplete never resolves. Before the fix, the timeout was cleared
    // once headers arrived, so the published entry was dedupe-d against forever
    // and navigation awaited a payload that never settled. The stall timeout
    // must now also bound the body and evict the entry.
    // Fresh stalling stream per call (a teed body cannot be reused).
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => {}); // never resolves -> read() hangs
            },
          }),
          { status: 200, headers: { "X-Test": "1" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";

    const { hasPrefetch } = await import("../browser/prefetch/cache");
    const wildcardKey =
      "v1:abc\0/blog?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

    prefetchDirect("/blog", ["A0"], "v1");
    // Let the fetch resolve and the `.then` publish the entry.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Headers arrived -> entry published even though the body is stalled.
    expect(hasPrefetch(wildcardKey)).toBe(true);
    // A re-prefetch dedupes against the published (stuck) entry — the bug.
    prefetchDirect("/blog", ["A0"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past the stall timeout: the body never finished, so the fetch's
    // stream is aborted and the published-but-never-settling entry is evicted.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(hasPrefetch(wildcardKey)).toBe(false);

    // A fresh prefetch now refetches instead of dedupe-ing against the stuck
    // entry / awaiting a payload that never settles.
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a stalled entry's eviction does NOT drop a fresh entry republished under the same key", async () => {
    vi.useFakeTimers();
    setupBrowser();

    // Call 1 stalls (its stall timer stays armed); call 2 (after the stalled
    // entry is consumed) republishes under the SAME key with a body that
    // completes. When call 1's timer fires, evicting by generation alone would
    // delete call 2's valid entry — identity-guarded eviction must spare it.
    let call = 0;
    const fetchMock = vi.fn(() => {
      call += 1;
      const body =
        call === 1
          ? new ReadableStream<Uint8Array>({
              pull() {
                return new Promise<void>(() => {}); // stall: never produces/closes
              },
            })
          : "payload"; // completes immediately
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "X-Test": "1" } }),
      );
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";

    const { hasPrefetch, consumePrefetch } =
      await import("../browser/prefetch/cache");
    const wildcardKey =
      "v1:abc\0/blog?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

    // A publishes (stalled); its stall timer is armed for 30s.
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPrefetch(wildcardKey)).toBe(true);

    // Navigation consumes A (removes it) while A's timer is still armed.
    expect(consumePrefetch(wildcardKey)).not.toBeNull();
    expect(hasPrefetch(wildcardKey)).toBe(false);

    // B republishes under the same key; its body completes so its own timer
    // clears, leaving only A's stale timer armed.
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hasPrefetch(wildcardKey)).toBe(true);

    // A's stall timer fires: identity guard means it does NOT delete B.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(hasPrefetch(wildcardKey)).toBe(true);
  });

  it("aborts a never-settling QUEUED prefetch (caller signal) so its key clears", async () => {
    vi.useFakeTimers();
    setupBrowser();

    // The queue passes its own AbortController signal. Without combining that
    // with the internal timeout, a stalled queued prefetch never settles and
    // strands the inflight key — the bug this layered-timeout fixes.
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          sig.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";

    const { hasPrefetch } = await import("../browser/prefetch/cache");
    const wildcardKey =
      "v1:abc\0/blog?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

    prefetchQueued("/blog", ["A0"], "v1");
    // Drive the queue's idle/image waits so the item actually executes.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hasPrefetch(wildcardKey)).toBe(true);
    // The queued fetch received a real caller signal (not undefined).
    expect(fetchMock.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);

    // Advance past the internal timeout: the combined signal fires, the stalled
    // fetch aborts and settles, running `.finally()` cleanup.
    await vi.advanceTimersByTimeAsync(31_000);

    expect(hasPrefetch(wildcardKey)).toBe(false);
  });

  it("clears the timeout when the fetch settles normally (no late abort)", async () => {
    vi.useFakeTimers();
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
    // Drain the fetch + decode microtasks.
    await vi.advanceTimersByTimeAsync(0);

    const { hasPrefetch, consumePrefetch } =
      await import("../browser/prefetch/cache");
    const wildcardKey =
      "v1:abc\0/blog?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

    // Entry is cached (timer was cleared on settle, fetch was never aborted).
    expect(hasPrefetch(wildcardKey)).toBe(true);
    expect(consumePrefetch(wildcardKey)).not.toBeNull();
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
    abortAllPrefetches();
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

/**
 * #622 follow-up (MEDIUM): `entry.complete` must mean "decoded + clean EOF",
 * never just "stream settled". teeWithCompletion resolves streamComplete on a
 * normal EOF AND on abort/read-error, so the flag must be gated on the
 * completion callback reporting `endedCleanly === true` AND a successful decode.
 * A broken or undecodable stream that is marked complete would let navigation
 * treat it as fully-prefetched and commit a corrupt fast path with no fallback.
 */
describe("prefetch entry.complete clean-EOF gating (#622 follow-up)", () => {
  beforeEach(() => {
    setupBrowser();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearPrefetchCache();
    abortAllPrefetches();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
    restoreGlobalProperty("navigator", originalNavigatorDescriptor);
  });

  const WILDCARD_KEY =
    "v1:abc\0/blog?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1";

  // Drain queued microtasks so the Promise.allSettled([payload, streamComplete])
  // callback that sets entry.complete has run.
  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("marks complete=true on a clean EOF with a successful decode", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response("payload", { status: 200, headers: { "X-Test": "1" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";
    prefetchDirect("/blog", ["A0"], "v1");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const entry = consumePrefetch(WILDCARD_KEY);
    expect(entry).not.toBeNull();
    await entry!.streamComplete;
    await flushMicrotasks();

    expect(entry!.complete).toBe(true);
  });

  it("evicts the entry when the stream errors mid-flight (not just complete=false)", async () => {
    // A body whose pull() throws errors the tracking stream's read(). The error
    // rejects out of teeWithCompletion's read loop into its .catch, which settles
    // streamComplete with endedCleanly = false. This is the stream-error path that
    // is NOT driven by the stall timeout (no abort, no 31s wait), so it isolates
    // the Promise.allSettled eviction from the timeout's own eviction. A broken
    // (errored) prefetch must be evicted, not left in the cache — navigation reads
    // `payload` regardless of `complete`, so a lingering errored entry would be
    // consumed once instead of refetching.
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              throw new Error("stream read error");
            },
          }),
          { status: 200, headers: { "X-Test": "1" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    // Decode resolves immediately (the decoder mock is synchronous): even with a
    // "successful" decode, an errored stream must NOT linger in the cache.

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";

    const { hasPrefetch } = await import("../browser/prefetch/cache");

    prefetchDirect("/blog", ["A0"], "v1");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The entry IS published once headers arrive — assert that first so the
    // eviction assertion below is not vacuously true. hasPrefetch is
    // non-destructive (unlike consumePrefetch, which deletes on read), so it
    // safely observes the published-then-evicted transition.
    await vi.waitFor(() => expect(hasPrefetch(WILDCARD_KEY)).toBe(true));
    // The eviction runs in the Promise.allSettled([payload, streamComplete])
    // callback, which only fires after the stream-error settles streamComplete
    // through teeWithCompletion's async reader. Poll until the entry is gone.
    await vi.waitFor(() => expect(hasPrefetch(WILDCARD_KEY)).toBe(false));
    // And a single consume confirms the cache map no longer holds it.
    expect(consumePrefetch(WILDCARD_KEY)).toBeNull();
  });

  it("evicts the entry when the eager decode fails (drained but undecodable)", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response("garbage", { status: 200, headers: { "X-Test": "1" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    // Decoder rejects: the stream drains cleanly (EOF) but the payload is
    // undecodable, so the entry is broken and must be evicted, not cached.
    decodeMock.mockImplementationOnce(() =>
      Promise.reject(new Error("decode failed")),
    );

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";

    const { hasPrefetch } = await import("../browser/prefetch/cache");

    prefetchDirect("/blog", ["A0"], "v1");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The entry IS published once headers arrive — assert that first so the
    // eviction assertion below is not vacuously true. hasPrefetch is
    // non-destructive, so it safely observes the published-then-evicted
    // transition (consumePrefetch deletes on read and would mask the bug).
    await vi.waitFor(() => expect(hasPrefetch(WILDCARD_KEY)).toBe(true));
    // The entry is evicted: navigation reads `payload` regardless of `complete`,
    // so a rejected payload left in the cache would be consumed once instead of
    // refetching. The eviction runs in the Promise.allSettled([payload,
    // streamComplete]) callback after the rejected decode settles. Poll until the
    // entry is gone.
    await vi.waitFor(() => expect(hasPrefetch(WILDCARD_KEY)).toBe(false));
    expect(consumePrefetch(WILDCARD_KEY)).toBeNull();
  });

  it("evicts on the early decode rejection even while the stream is still hung (does not wait for the stall timeout)", async () => {
    // The decode rejects EARLY while the response body / tracking stream HANGS:
    // a ReadableStream whose pull() never enqueues or closes, so it never reaches
    // EOF and never aborts. streamComplete therefore never settles on its own.
    // Eviction must fire off the earliest failure signal (the rejected decode),
    // NOT wait for Promise.allSettled([payload, streamComplete]) — which would
    // hang until the 30s stall-timeout backstop fires. We assert eviction well
    // before that timeout, proving the early payload.catch handler did the work.
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => {}); // never enqueues/closes -> read() hangs, no EOF, no abort
            },
          }),
          { status: 200, headers: { "X-Test": "1" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    // Decoder rejects early, before the (hung) stream reaches EOF.
    decodeMock.mockImplementationOnce(() =>
      Promise.reject(new Error("decode failed early")),
    );

    window.location.href = "http://localhost:4173/home";
    (window.location as any).pathname = "/home";

    const { hasPrefetch } = await import("../browser/prefetch/cache");

    prefetchDirect("/blog", ["A0"], "v1");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Entry IS published once headers arrive — assert first so the eviction
    // assertion is not vacuously true.
    await vi.waitFor(() => expect(hasPrefetch(WILDCARD_KEY)).toBe(true));
    // Eviction must happen on the early payload.catch, NOT the stall timeout:
    // poll with a timeout WELL BELOW the 30s stall timer. If eviction only
    // happened in the allSettled/stall backstop, this would time out (the
    // stream never settles streamComplete on its own).
    await vi.waitFor(() => expect(hasPrefetch(WILDCARD_KEY)).toBe(false), {
      timeout: 2_000,
    });
    expect(consumePrefetch(WILDCARD_KEY)).toBeNull();
  });
});
