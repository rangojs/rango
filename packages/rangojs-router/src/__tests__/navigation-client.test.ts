import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError, ServerRedirect } from "../errors";

const {
  getRangoStateMock,
  consumePrefetchMock,
  consumeInflightPrefetchMock,
  buildPrefetchKeyMock,
  buildSourceKeyMock,
} = vi.hoisted(() => ({
  getRangoStateMock: vi.fn(() => "v1:abc"),
  consumePrefetchMock: vi.fn((_key?: string): Response | null => null),
  consumeInflightPrefetchMock: vi.fn(
    (): Promise<Response | null> | null => null,
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
    it("uses completed cache entry without fetching", async () => {
      const cachedBody = "cached-rsc-payload";
      consumePrefetchMock.mockReturnValue(new Response(cachedBody));

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const client = createNavigationClient({
        createFromFetch: async (responsePromise: Promise<Response>) => {
          const response = await responsePromise;
          const text = await response.clone().text();
          return { metadata: { matched: [], diff: [], body: text } };
        },
      } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.payload.metadata).toMatchObject({ matched: [], diff: [] });
      expect(consumePrefetchMock).toHaveBeenCalledTimes(1);
    });

    it("reuses an in-flight prefetch response without starting a fresh fetch", async () => {
      consumeInflightPrefetchMock.mockReturnValue(
        Promise.resolve(new Response("prefetched-stream", { status: 200 })),
      );

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const client = createNavigationClient({
        createFromFetch: async (responsePromise: Promise<Response>) => {
          const response = await responsePromise;
          const text = await response.clone().text();
          return { metadata: { matched: [], diff: [], body: text } };
        },
      } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(fetchMock).not.toHaveBeenCalled();
      // Called twice: exact key (miss) + wildcard key (miss)
      expect(consumePrefetchMock).toHaveBeenCalledTimes(2);
      expect(consumeInflightPrefetchMock).toHaveBeenCalledTimes(1);
      expect(result.payload.metadata).toMatchObject({
        matched: [],
        diff: [],
        body: "prefetched-stream",
      });
    });

    it("falls back to a fresh fetch when the in-flight prefetch resolves null", async () => {
      consumeInflightPrefetchMock.mockReturnValue(Promise.resolve(null));

      const fetchMock = vi.fn(
        async () => new Response("fresh-payload", { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const client = createNavigationClient({
        createFromFetch: async (responsePromise: Promise<Response>) => {
          const response = await responsePromise;
          const text = await response.clone().text();
          return { metadata: { matched: [], diff: [], body: text } };
        },
      } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Called twice: exact key (miss) + wildcard key (miss)
      expect(consumePrefetchMock).toHaveBeenCalledTimes(2);
      expect(consumeInflightPrefetchMock).toHaveBeenCalledTimes(1);
      expect(result.payload.metadata).toMatchObject({
        matched: [],
        diff: [],
        body: "fresh-payload",
      });
    });

    it("falls back to wildcard key when exact key misses", async () => {
      const cachedBody = "wildcard-cached";
      // Hit only the wildcard slot (exactly one \0 after the rango state;
      // source-scoped keys insert an extra \0<source>\0 segment).
      consumePrefetchMock.mockImplementation(
        (key?: string): Response | null => {
          if (!key) return null;
          let nullCount = 0;
          for (let i = 0; i < key.length; i++) {
            if (key.charCodeAt(i) === 0) nullCount++;
          }
          if (nullCount === 1 && key.startsWith("v1:abc\0")) {
            return new Response(cachedBody);
          }
          return null;
        },
      );

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const client = createNavigationClient({
        createFromFetch: async (responsePromise: Promise<Response>) => {
          const response = await responsePromise;
          const text = await response.clone().text();
          return { metadata: { matched: [], diff: [], body: text } };
        },
      } as any);

      const result = await client.fetchPartial({
        targetUrl: "/products",
        previousUrl: "/current",
        segmentIds: ["root"],
      });

      expect(fetchMock).not.toHaveBeenCalled();
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
});
