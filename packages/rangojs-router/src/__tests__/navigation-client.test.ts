import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError, ServerRedirect } from "../errors";
import type { DecodedPrefetch } from "../browser/prefetch/cache";

const {
  getRangoStateMock,
  consumePrefetchMock,
  consumeInflightPrefetchMock,
  buildPrefetchKeyMock,
  buildSourceKeyMock,
} = vi.hoisted(() => ({
  getRangoStateMock: vi.fn(() => "v1:abc"),
  consumePrefetchMock: vi.fn((_key?: string): DecodedPrefetch | null => null),
  consumeInflightPrefetchMock: vi.fn(
    (): Promise<DecodedPrefetch | null> | null => null,
  ),
  buildPrefetchKeyMock: vi.fn(
    (source: string, target: URL) =>
      source + "\0" + target.pathname + target.search,
  ),
  buildSourceKeyMock: vi.fn(
    (rangoState: string, sourceHref: string, target: URL) =>
      rangoState + "\0" + sourceHref + "\0" + target.pathname + target.search,
  ),
}));

/**
 * Build a decoded prefetch entry. Prefetch decodes eagerly, so a warm hit
 * carries an already-decoded payload; navigation reuses it without calling
 * createFromFetch again.
 */
function makeEntry(
  payload: unknown,
  scope: "source" | "wildcard" = "wildcard",
  complete = false,
): DecodedPrefetch {
  return {
    payload: Promise.resolve(payload) as Promise<any>,
    streamComplete: Promise.resolve(),
    scope,
    complete,
  };
}

vi.mock("../browser/rango-state", () => ({
  getRangoState: getRangoStateMock,
}));

vi.mock("../browser/prefetch/cache", () => ({
  consumePrefetch: consumePrefetchMock,
  consumeInflightPrefetch: consumeInflightPrefetchMock,
  buildPrefetchKey: buildPrefetchKeyMock,
  buildSourceKey: buildSourceKeyMock,
}));

import { createNavigationClient } from "../browser/navigation-client";
import { enterActionFence, __resetActionFence } from "../browser/action-fence";

describe("navigation-client", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost",
        href: "http://localhost/current",
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    consumePrefetchMock.mockReset().mockReturnValue(null);
    consumeInflightPrefetchMock.mockReset().mockReturnValue(null);
  });

  it("builds partial fetch URL and headers", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const createFromFetch = vi.fn(
      async (responsePromise: Promise<Response>) => {
        await responsePromise;
        return { metadata: { matched: [], diff: [], isPartial: true } };
      },
    );

    const client = createNavigationClient({ createFromFetch } as any);
    const signal = new AbortController().signal;

    const result = await client.fetchPartial({
      targetUrl: "/products",
      previousUrl: "/current",
      segmentIds: ["root", "products"],
      staleRevalidation: true,
      version: "v7",
      signal,
    });

    const fetchCall = fetchMock.mock.calls[0] as unknown;
    expect(fetchCall).toBeDefined();
    const fetchUrl = (fetchCall as [unknown, RequestInit | undefined])[0];
    const init = ((fetchCall as [unknown, RequestInit | undefined])[1] ??
      {}) as RequestInit;
    expect(String(fetchUrl)).toContain(
      "/products?_rsc_partial=true&_rsc_segments=root%2Cproducts&_rsc_stale=true&_rsc_v=v7",
    );
    expect(init.signal).toBe(signal);
    expect(
      (init.headers as Record<string, string>)["X-RSC-Router-Client-Path"],
    ).toBe("/current");
    expect((init.headers as Record<string, string>)["X-Rango-State"]).toBe(
      "v1:abc",
    );

    await expect(result.streamComplete).resolves.toBeUndefined();
  });

  it("reads rango state once per fetch, threading it into the header (B6)", async () => {
    getRangoStateMock.mockClear();
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const createFromFetch = vi.fn(
      async (responsePromise: Promise<Response>) => {
        await responsePromise;
        return { metadata: { matched: [], diff: [], isPartial: true } };
      },
    );

    const client = createNavigationClient({ createFromFetch } as any);
    // Cache-miss fresh fetch (no staleRevalidation): the cache-key lookup and
    // the fetch header must share ONE rango-state read. Previously two.
    await client.fetchPartial({
      targetUrl: "/products",
      previousUrl: "/current",
      segmentIds: ["root"],
    });

    expect(getRangoStateMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0]![1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>)["X-Rango-State"]).toBe(
      "v1:abc",
    );
  });

  it("reloads to the navigation target when the response router id does not match", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "X-RSC-Router-Id": "other-app" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const createFromFetch = vi.fn(async () => ({
      metadata: { isPartial: true },
    }));
    const client = createNavigationClient({ createFromFetch } as any);

    // Client is "client-app"; the response belongs to "other-app" (a stale/edge
    // cache or proxy mix-up). The integrity check reloads to the target instead
    // of decoding + applying the foreign payload.
    client
      .fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
        routerId: "client-app",
      })
      .catch(() => {});

    await vi.waitFor(() =>
      expect((window as any).location.href).toBe("/products"),
    );
  });

  it("lets the reload header win over a router-id mismatch (no double reload)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: {
            "X-RSC-Reload": "http://localhost/reloaded",
            "X-RSC-Router-Id": "other-app",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const createFromFetch = vi.fn(async () => ({ metadata: {} }));
    const client = createNavigationClient({ createFromFetch } as any);

    client
      .fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
        routerId: "client-app",
      })
      .catch(() => {});

    // The reload header is handled first (ordered before the routerId check),
    // so we reload to the header's URL, not the navigation target.
    await vi.waitFor(() =>
      expect((window as any).location.href).toBe("http://localhost/reloaded"),
    );
  });

  it("wraps network failures as NetworkError", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = createNavigationClient({
      createFromFetch: async (responsePromise: Promise<Response>) => {
        await responsePromise;
        return { metadata: {} };
      },
    } as any);

    try {
      await client.fetchPartial({
        targetUrl: "/checkout",
        previousUrl: "/cart",
        segmentIds: ["root"],
      });
      throw new Error("expected fetchPartial to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).operation).toBe("navigation");
      expect((error as NetworkError).url).toContain("_rsc_partial=true");
    }
  });

  it("throws ServerRedirect for same-origin X-RSC-Redirect", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 204,
          headers: { "X-RSC-Redirect": "/login" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = createNavigationClient({
      createFromFetch: async (responsePromise: Promise<Response>) => {
        await responsePromise;
        return { metadata: {} };
      },
    } as any);

    await expect(
      client.fetchPartial({
        targetUrl: "/private",
        previousUrl: "/",
        segmentIds: ["root"],
      }),
    ).rejects.toBeInstanceOf(ServerRedirect);
  });

  it("ignores cross-origin X-RSC-Redirect", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "X-RSC-Redirect": "https://evil.example/phish" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = createNavigationClient({
      createFromFetch: async (responsePromise: Promise<Response>) => {
        await responsePromise;
        return { metadata: { matched: [], diff: [] } };
      },
    } as any);

    await expect(
      client.fetchPartial({
        targetUrl: "/safe",
        previousUrl: "/",
        segmentIds: ["root"],
      }),
    ).resolves.toMatchObject({
      payload: { metadata: { matched: [], diff: [] } },
    });
  });

  describe("prefetch cache integration", () => {
    it("uses the completed cache entry without fetching or re-decoding", async () => {
      consumePrefetchMock.mockReturnValue(
        makeEntry({ metadata: { matched: [], diff: [] } }),
      );

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      // Warm hits reuse the eagerly-decoded payload — createFromFetch (the
      // decode) must NOT run again on the click.
      const createFromFetch = vi.fn();
      const client = createNavigationClient({ createFromFetch } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(createFromFetch).not.toHaveBeenCalled();
      expect(result.payload.metadata).toMatchObject({ matched: [], diff: [] });
      expect(consumePrefetchMock).toHaveBeenCalledTimes(1);
    });

    // #622 follow-up: fullyPrefetched is the prefetch entry's `complete` flag,
    // which after the MEDIUM fix is true ONLY on a clean EOF + successful decode.
    // It plumbs straight through fetchPartial into the partial-update commit
    // branch, so navigation only takes the no-flash fast path on a healthy entry.
    it("propagates fullyPrefetched=true when the cache entry is complete", async () => {
      consumePrefetchMock.mockReturnValue(
        makeEntry({ metadata: { matched: [], diff: [] } }, "wildcard", true),
      );
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      const client = createNavigationClient({
        createFromFetch: vi.fn(),
      } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(result.fullyPrefetched).toBe(true);
    });

    it("propagates fullyPrefetched=false when the cache entry is not complete (aborted/errored/streaming)", async () => {
      consumePrefetchMock.mockReturnValue(
        makeEntry({ metadata: { matched: [], diff: [] } }, "wildcard", false),
      );
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      const client = createNavigationClient({
        createFromFetch: vi.fn(),
      } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(result.fullyPrefetched).toBe(false);
    });

    it("reuses an in-flight prefetch entry without fetching or re-decoding", async () => {
      consumeInflightPrefetchMock.mockReturnValue(
        Promise.resolve(makeEntry({ metadata: { matched: [], diff: [] } })),
      );

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const createFromFetch = vi.fn();
      const client = createNavigationClient({ createFromFetch } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(createFromFetch).not.toHaveBeenCalled();
      // Called twice: exact key (miss) + wildcard key (miss)
      expect(consumePrefetchMock).toHaveBeenCalledTimes(2);
      expect(consumeInflightPrefetchMock).toHaveBeenCalledTimes(1);
      expect(result.payload.metadata).toMatchObject({ matched: [], diff: [] });
    });

    it("falls back to a fresh fetch when the in-flight prefetch resolves null", async () => {
      consumeInflightPrefetchMock.mockReturnValue(Promise.resolve(null));

      const fetchMock = vi.fn(
        async () => new Response("fresh-payload", { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const createFromFetch = vi.fn(
        async (responsePromise: Promise<Response>) => {
          const response = await responsePromise;
          const text = await response.clone().text();
          return { metadata: { matched: [], diff: [], body: text } };
        },
      );
      const client = createNavigationClient({ createFromFetch } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(createFromFetch).toHaveBeenCalledTimes(1);
      // Called twice: exact key (miss) + wildcard key (miss)
      expect(consumePrefetchMock).toHaveBeenCalledTimes(2);
      expect(consumeInflightPrefetchMock).toHaveBeenCalledTimes(1);
      expect(result.payload.metadata).toMatchObject({
        matched: [],
        diff: [],
        body: "fresh-payload",
      });
    });

    it("discards a wildcard-adopted inflight that turns out source-scoped, then refetches", async () => {
      // Miss the source key (2 nulls), adopt the wildcard inflight (1 null).
      // The resolved entry is source-scoped — built for a different source
      // page — so it must be dropped in favor of a fresh fetch.
      consumeInflightPrefetchMock.mockImplementation((key?: string) => {
        if (!key) return null;
        let nullCount = 0;
        for (let i = 0; i < key.length; i++) {
          if (key.charCodeAt(i) === 0) nullCount++;
        }
        return nullCount === 1
          ? Promise.resolve(makeEntry({ metadata: {} }, "source"))
          : null;
      });

      const fetchMock = vi.fn(
        async () => new Response("fresh", { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const createFromFetch = vi.fn(
        async (responsePromise: Promise<Response>) => {
          const response = await responsePromise;
          return { metadata: { body: await response.clone().text() } };
        },
      );
      const client = createNavigationClient({ createFromFetch } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(createFromFetch).toHaveBeenCalledTimes(1);
      expect(result.payload.metadata).toMatchObject({ body: "fresh" });
    });

    it("falls back to wildcard key when exact key misses", async () => {
      // Hit only the wildcard slot (exactly one \0 after the rango state;
      // source-scoped keys insert an extra \0<source>\0 segment).
      consumePrefetchMock.mockImplementation(
        (key?: string): DecodedPrefetch | null => {
          if (!key) return null;
          let nullCount = 0;
          for (let i = 0; i < key.length; i++) {
            if (key.charCodeAt(i) === 0) nullCount++;
          }
          if (nullCount === 1 && key.startsWith("v1:abc\0")) {
            return makeEntry({ metadata: { body: "wildcard-cached" } });
          }
          return null;
        },
      );

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const createFromFetch = vi.fn();
      const client = createNavigationClient({ createFromFetch } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(createFromFetch).not.toHaveBeenCalled();
      expect(consumePrefetchMock).toHaveBeenCalledTimes(2);
      expect(result.payload.metadata).toMatchObject({
        body: "wildcard-cached",
      });
    });

    it("skips prefetch cache for stale revalidation", async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const client = createNavigationClient({
        createFromFetch: async (responsePromise: Promise<Response>) => {
          await responsePromise;
          return { metadata: { matched: [], diff: [] } };
        },
      } as any);

      await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
        staleRevalidation: true,
      });

      expect(consumePrefetchMock).not.toHaveBeenCalled();
      expect(consumeInflightPrefetchMock).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetch options (credentials + action fence)", () => {
    afterEach(() => __resetActionFence());

    async function freshFetchInit(): Promise<RequestInit> {
      const fetchMock = vi.fn(
        async (_url: string | URL, _init?: RequestInit) =>
          new Response(null, { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
      const client = createNavigationClient({
        createFromFetch: async (responsePromise: Promise<Response>) => {
          await responsePromise;
          return { metadata: { matched: [], diff: [], isPartial: true } };
        },
      } as any);
      // staleRevalidation skips the prefetch cache, so this always hits the
      // fresh-fetch path where the cache mode and credentials are decided.
      await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
        staleRevalidation: true,
      });
      return (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
    }

    it("does not set credentials to omit (the rango-state Set-Cookie must apply)", async () => {
      const init = await freshFetchInit();
      // Absent => the fetch default (same-origin) credentials, so a Set-Cookie
      // on the navigation response is applied. `omit` would silently drop the
      // server's state rotation.
      expect(init.credentials).toBeUndefined();
    });

    it("uses cache:no-store during an active action fence", async () => {
      enterActionFence();
      const init = await freshFetchInit();
      expect(init.cache).toBe("no-store");
    });

    it("does not override the cache mode when no action fence is active", async () => {
      const init = await freshFetchInit();
      expect(init.cache).toBeUndefined();
    });
  });
});
