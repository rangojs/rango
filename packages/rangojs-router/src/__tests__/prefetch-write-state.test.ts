import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeJar, type CookieJarMock } from "./cookie-jar-mock.js";
import {
  prefetchDirect,
  prefetchQueued,
  setPrefetchDecoder,
} from "../browser/prefetch/fetch";
import {
  initRangoState,
  setRangoStateObserver,
  setRangoStateWriteObserver,
} from "../browser/rango-state";
import { createNavigationStore } from "../browser/navigation-store";
import { enterActionFence, exitActionFence } from "../browser/action-fence";
import { registerNavigationStore } from "../browser/navigation-store-handle";
import {
  clearPrefetchCache,
  markPrefetchesStale,
} from "../browser/prefetch/cache";
import { resetPrefetchPolicy } from "../browser/prefetch/policy";
import { stateEpoch } from "../browser/cookie-name";
import { abortAllPrefetches } from "../browser/prefetch/queue";
import { createNavigationClient } from "../browser/navigation-client";
import type { FetchPartialResult, RscPayload } from "../browser/types";

/**
 * A server action without a directive bumps only the write part of the rango
 * state (`{version}:{timestamp}:{write}`, its response's Set-Cookie). Real
 * rango state over a cookie jar, prefetch fetch, cache and navigation client;
 * fetch is stubbed.
 *
 * - The in-memory prefetch keys hold only `{version}:{timestamp}`: a prefetch
 *   made before the write is still found after it, stale, and served once to
 *   a click, as when the state did not change at all.
 * - Every request after the write sends the whole new value as
 *   `X-Rango-State`, so the browser HTTP cache (which varies on it) misses on
 *   what it holds from before the write: the click's next request, a hover
 *   after it, and a viewport prefetch queued before it that runs after it.
 */

const SOURCE = "http://localhost:4173/current";
const NAME = "rango-state_router_0";

const encoder = new TextEncoder();

/** Each fetch answers at once with "body"; the headers it sent are kept. */
function stubServer(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    (_url: string | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode("body"));
            c.close();
          },
        });
        resolve(new Response(body));
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentState(fetchMock: ReturnType<typeof vi.fn>, call: number): string {
  const init = fetchMock.mock.calls[call]![1] as RequestInit;
  return (init.headers as Record<string, string>)["X-Rango-State"]!;
}

async function decode(responsePromise: Promise<Response>): Promise<RscPayload> {
  const response = await responsePromise;
  const rest = response.text();
  rest.catch(() => {});
  return { metadata: { isPartial: true }, rest } as unknown as RscPayload;
}

function clickBlog(): Promise<FetchPartialResult> {
  const client = createNavigationClient({
    createFromFetch: decode,
    createFromReadableStream: vi.fn(),
  } as never);
  return client.fetchPartial({
    targetUrl: "/blog",
    previousUrl: SOURCE,
    segmentIds: ["A0"],
    version: "v1",
    acceptStalePrefetch: true,
  });
}

describe("a server action's write bump of the rango state", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let jar: CookieJarMock;

  beforeEach(() => {
    vi.useFakeTimers();
    setPrefetchDecoder(decode);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        location: {
          origin: "http://localhost:4173",
          href: SOURCE,
          pathname: "/current",
          search: "",
          protocol: "http:",
        },
        matchMedia: vi.fn(() => ({ matches: false }) as MediaQueryList),
      },
    });
    vi.stubGlobal("location", { protocol: "http:" });
    jar = makeJar({ [NAME]: "v1:100" });
    vi.stubGlobal(
      "document",
      Object.assign(jar.jar, { querySelectorAll: () => [] }),
    );
    initRangoState("v1", NAME);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearPrefetchCache(false);
    abortAllPrefetches();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it("keeps a prefetch made before it: a click takes it stale, and the next request sends the bumped value", async () => {
    const fetchMock = stubServer();
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(10);
    expect(sentState(fetchMock, 0)).toBe("v1:100");

    // The action's response: Set-Cookie with a new write part, then the
    // bridge marks the prefetches stale.
    jar.set(NAME, "v1:100:5000");
    markPrefetchesStale();

    const click = await clickBlog();
    expect(
      fetchMock,
      "the click is answered from memory",
    ).toHaveBeenCalledTimes(1);
    expect(click.stalePrefetch).toBe(true);

    // A stale entry is served once: the next click fetches, with the whole
    // new value, so the browser HTTP cache misses on the pre-write answer.
    const second = await clickBlog();
    expect(second.stalePrefetch).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentState(fetchMock, 1)).toBe("v1:100:5000");
  });

  it("a hover after it prefetches again with the bumped value", async () => {
    const fetchMock = stubServer();
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(10);

    jar.set(NAME, "v1:100:5000");
    markPrefetchesStale();

    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentState(fetchMock, 1)).toBe("v1:100:5000");
  });

  it("a prefetch queued before it and run after it sends the bumped value", async () => {
    const fetchMock = stubServer();
    prefetchQueued("/blog", ["A0"], "v1");
    expect(fetchMock).not.toHaveBeenCalled();

    jar.set(NAME, "v1:100:5000");
    markPrefetchesStale();

    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentState(fetchMock, 0)).toBe("v1:100:5000");
  });

  /**
   * A tab that no broadcast reaches (crossTabSync off here; a page that shares
   * no segment with the acting page reads the same) learns of another tab's
   * write only from the cookie. The read that sees it marks this tab's
   * prefetches stale (rango-state.ts write observer, wired by
   * registerNavigationStore).
   */
  describe("seen only through the cookie", () => {
    let store: ReturnType<typeof createNavigationStore>;

    beforeEach(() => {
      store = createNavigationStore({
        initialLocation: { href: SOURCE },
        crossTabSync: false,
      });
      registerNavigationStore(store);
    });

    afterEach(() => {
      setRangoStateObserver(null);
      setRangoStateWriteObserver(null);
    });

    it("a click takes the prefetch made before it stale", async () => {
      const fetchMock = stubServer();
      prefetchDirect("/blog", ["A0"], "v1");
      await vi.advanceTimersByTimeAsync(10);

      // Another tab's action: only its Set-Cookie reaches this tab.
      jar.set(NAME, "v1:100:5000");

      const click = await clickBlog();
      expect(
        fetchMock,
        "the click is answered from memory",
      ).toHaveBeenCalledTimes(1);
      expect(click.stalePrefetch).toBe(true);
    });

    it("marks history entries stale", () => {
      stubServer();
      store.cacheSegmentsForHistory("/current", []);
      jar.set(NAME, "v1:100:5000");
      prefetchDirect("/blog", ["A0"], "v1");
      expect(store.getCachedSegments("/current")!.stale).toBe(true);
    });

    it("a prefetch sent with the new value stays fresh through later reads", async () => {
      const fetchMock = stubServer();
      prefetchDirect("/blog", ["A0"], "v1");
      await vi.advanceTimersByTimeAsync(10);

      jar.set(NAME, "v1:100:5000");
      // The hover's read sees the write and marks the old entry stale, so the
      // hover prefetches again, sending the new value.
      prefetchDirect("/blog", ["A0"], "v1");
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentState(fetchMock, 1)).toBe("v1:100:5000");

      prefetchDirect("/other", ["A0"], "v1");
      await vi.advanceTimersByTimeAsync(10);
      const click = await clickBlog();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(click.stalePrefetch).toBe(false);
    });

    it("a queued prefetch that runs after it does not count the entry from before it as a hit", async () => {
      const fetchMock = stubServer();
      // A viewport prefetch waits in the queue while a hover's prefetch of
      // the same page is answered from before the write.
      prefetchQueued("/blog", ["A0"], "v1");
      prefetchDirect("/blog", ["A0"], "v1");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      jar.set(NAME, "v1:100:5000");

      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentState(fetchMock, 1)).toBe("v1:100:5000");
    });

    it("the acting tab's landing does not stale a prefetch it sends after it", async () => {
      const fetchMock = stubServer();
      prefetchDirect("/blog", ["A0"], "v1");
      await vi.advanceTimersByTimeAsync(10);

      // This tab's own action: its response's Set-Cookie, then its landing,
      // inside the action's fence.
      enterActionFence();
      jar.set(NAME, "v1:100:5000");
      store.markCacheAsStaleAndBroadcast();
      exitActionFence();

      prefetchDirect("/blog", ["A0"], "v1");
      await vi.advanceTimersByTimeAsync(10);
      expect(sentState(fetchMock, 1)).toBe("v1:100:5000");

      const click = await clickBlog();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(click.stalePrefetch).toBe(false);
    });
  });

  // navigation-store.ts keeps the first BroadcastChannel it opens for the
  // module's life, so every case talks through this one object.
  const channel: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: (message: unknown) => void;
  } = { onmessage: null, postMessage: vi.fn() };

  /**
   * A jar that keeps no state value: cookies blocked (the read is empty and
   * a write is dropped) or a sandboxed frame (the read throws). The action's
   * Set-Cookie never reaches it, so the mirror takes the write: a hover after
   * the landing sends a value the browser HTTP cache holds nothing under.
   */
  describe.each([
    {
      jar: "drops the cookie",
      doc: (): object => ({
        get cookie(): string {
          return "";
        },
        set cookie(_v: string) {},
      }),
    },
    {
      jar: "cannot be read",
      doc: (): object => ({
        get cookie(): string {
          throw new Error("blocked");
        },
        set cookie(_v: string) {
          throw new Error("blocked");
        },
      }),
    },
  ])("where the jar $jar", ({ doc }) => {
    beforeEach(() => {
      vi.stubGlobal(
        "document",
        Object.assign(doc(), { querySelectorAll: () => [] }),
      );
      initRangoState("v1", NAME);
      channel.onmessage = null;
      channel.postMessage = vi.fn();
      vi.stubGlobal(
        "BroadcastChannel",
        class {
          set onmessage(listener: ((event: MessageEvent) => void) | null) {
            channel.onmessage = listener;
          }

          postMessage(message: unknown): void {
            channel.postMessage(message);
          }
        },
      );
    });

    afterEach(() => {
      setRangoStateObserver(null);
      setRangoStateWriteObserver(null);
    });

    function makeStore(): ReturnType<typeof createNavigationStore> {
      const store = createNavigationStore({
        initialLocation: { href: SOURCE },
        initialSegmentIds: ["A0"],
        crossTabSync: true,
      });
      registerNavigationStore(store);
      return store;
    }

    it("the acting tab's landing changes the state a hover after it sends, keeping its epoch", async () => {
      const store = makeStore();
      const fetchMock = stubServer();
      prefetchDirect("/blog", ["A0"], "v1");
      await vi.advanceTimersByTimeAsync(10);
      const before = sentState(fetchMock, 0);

      enterActionFence();
      store.markCacheAsStaleAndBroadcast();
      exitActionFence();

      prefetchDirect("/blog", ["A0"], "v1");
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const after = sentState(fetchMock, 1);
      expect(after, "a value no response was cached under").not.toBe(before);
      expect(stateEpoch(after)).toBe(stateEpoch(before));
      // The soft broadcast carries it.
      expect(channel.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ soft: true, rangoState: after }),
      );

      // The prefetch sent after the landing is fresh.
      const click = await clickBlog();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(click.stalePrefetch).toBe(false);
    });

    it("another tab's soft broadcast changes the state this tab sends", async () => {
      makeStore();
      const fetchMock = stubServer();
      prefetchDirect("/blog", ["A0"], "v1");
      await vi.advanceTimersByTimeAsync(10);
      const before = sentState(fetchMock, 0);

      // The sender's mirror is its own (no shared jar): an older timestamp,
      // so this tab adopts nothing.
      channel.onmessage?.({
        data: {
          type: "invalidate",
          path: "/current",
          segmentIds: ["A0"],
          rangoState: "v1:1:5000",
          stateCookieName: NAME,
          soft: true,
        },
      } as MessageEvent);

      prefetchDirect("/blog", ["A0"], "v1");
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const after = sentState(fetchMock, 1);
      expect(after).not.toBe(before);
      expect(stateEpoch(after)).toBe(stateEpoch(before));
    });
  });
});
