import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeJar, type CookieJarMock } from "./cookie-jar-mock.js";
import {
  prefetchDirect,
  prefetchQueued,
  setPrefetchDecoder,
} from "../browser/prefetch/fetch";
import { initRangoState } from "../browser/rango-state";
import {
  clearPrefetchCache,
  markPrefetchesStale,
} from "../browser/prefetch/cache";
import { resetPrefetchPolicy } from "../browser/prefetch/policy";
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
});
