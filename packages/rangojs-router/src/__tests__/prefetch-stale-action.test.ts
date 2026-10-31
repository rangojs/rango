import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefetchDirect, setPrefetchDecoder } from "../browser/prefetch/fetch";
import { getRangoState } from "../browser/rango-state";
import {
  buildPrefetchKey,
  clearPrefetchCache,
  hasPrefetch,
  markPrefetchesStale,
} from "../browser/prefetch/cache";
import { resetPrefetchPolicy } from "../browser/prefetch/policy";
import { abortAllPrefetches } from "../browser/prefetch/queue";
import { createNavigationClient } from "../browser/navigation-client";
import type { FetchPartialResult, RscPayload } from "../browser/types";

/**
 * A server action without a directive marks every prefetch stale (#1329,
 * rango-d221). Real prefetch fetch, cache and navigation client; fetch is
 * stubbed with a body the test streams, and the decoder exposes the body's
 * text as the payload's `rest`, so a test reads the bytes a navigation was
 * answered with.
 *
 * - Only a click takes a stale prefetch (`acceptStalePrefetch`): it
 *   revalidates its page once it settled. Every other navigation (Back on a
 *   history-cache miss, leaving an intercept) treats a stale stored entry as
 *   a miss and drops a stale in-flight one, so none commits pre-write data
 *   it never revalidates.
 * - A prefetch whose stream ends after the action and before any click is
 *   stored stale with its whole body.
 * - A stale entry is served at most once: a second click fetches fresh.
 */

const SOURCE = "http://localhost:4173/current";

/**
 * The wildcard key prefetchDirect("/blog", ..., "v1") stores under. There is
 * no document here, so the state is the mirror's (rango-state.ts), which the
 * flush after each case rotates: read it when asked.
 */
const blogKey = (): string =>
  buildPrefetchKey(
    getRangoState(),
    new URL("http://localhost:4173/blog?_rsc_partial=true&_rsc_v=v1"),
  );

interface ServerResponse {
  respond(): void;
  push(text: string): void;
  end(): void;
}

const encoder = new TextEncoder();
let responses: ServerResponse[] = [];

/** Each fetch opens a stream that sends "head;" and stays open. */
function stubServer({ holdHeaders = false } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let closed = false;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(encoder.encode("head;"));
          },
        });
        const respond = () => resolve(new Response(body));
        responses.push({
          respond,
          push(text) {
            if (!closed) controller.enqueue(encoder.encode(text));
          },
          end() {
            if (!closed) controller.close();
            closed = true;
          },
        });
        if (!holdHeaders) respond();
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function decode(responsePromise: Promise<Response>): Promise<RscPayload> {
  const response = await responsePromise;
  const rest = response.text();
  rest.catch(() => {});
  return { metadata: { isPartial: true }, rest } as unknown as RscPayload;
}

function restOf(result: FetchPartialResult): Promise<string> {
  return (result.payload as unknown as { rest: Promise<string> }).rest;
}

/**
 * A navigation to /blog from SOURCE. `click` is a link click, which takes a
 * stale prefetch; without it the navigation is one that never revalidates.
 */
function navigateToBlog(click: boolean): Promise<FetchPartialResult> {
  const client = createNavigationClient({
    createFromFetch: decode,
    createFromReadableStream: vi.fn(),
  } as never);
  return client.fetchPartial({
    targetUrl: "/blog",
    previousUrl: SOURCE,
    segmentIds: ["A0"],
    version: "v1",
    acceptStalePrefetch: click,
  });
}

/** Prefetch /blog and let its whole body arrive. */
async function completedPrefetch(): Promise<void> {
  prefetchDirect("/blog", ["A0"], "v1");
  await vi.advanceTimersByTimeAsync(10);
  responses[0]!.push("prefetched");
  responses[0]!.end();
  await vi.advanceTimersByTimeAsync(10);
  expect(hasPrefetch(blogKey())).toBe(true);
}

describe("a prefetch a server action marked stale", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

  beforeEach(() => {
    vi.useFakeTimers();
    responses = [];
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
        },
        matchMedia: vi.fn(() => ({ matches: false }) as MediaQueryList),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearPrefetchCache();
    abortAllPrefetches();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it("is a miss for a navigation that never revalidates, and stays for a click", async () => {
    const fetchMock = stubServer();
    await completedPrefetch();
    markPrefetchesStale();

    // Back onto an entry the history cache evicted: fetched fresh.
    const back = await navigateToBlog(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(back.stalePrefetch).toBe(false);
    responses[1]!.push("fresh");
    responses[1]!.end();
    await expect(restOf(back)).resolves.toBe("head;fresh");

    // A click still takes it, and revalidates afterwards.
    const click = await navigateToBlog(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(click.stalePrefetch).toBe(true);
    await expect(restOf(click)).resolves.toBe("head;prefetched");
  });

  it("in flight, is dropped and fetched again by a navigation that never revalidates", async () => {
    const fetchMock = stubServer({ holdHeaders: true });
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(10);
    markPrefetchesStale();

    const navigation = navigateToBlog(false);
    await vi.advanceTimersByTimeAsync(10);
    responses[0]!.respond();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    responses[1]!.respond();
    responses[1]!.push("fresh");
    responses[1]!.end();

    const result = await navigation;
    expect(result.stalePrefetch).toBe(false);
    await expect(restOf(result)).resolves.toBe("head;fresh");
  });

  it("whose stream ends after the action and before any click, is stored stale with its whole body", async () => {
    const fetchMock = stubServer();
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(10);

    // The action lands while the prefetch streams; the stream then ends.
    markPrefetchesStale();
    responses[0]!.push("tail");
    responses[0]!.end();
    await vi.advanceTimersByTimeAsync(10);

    const click = await navigateToBlog(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(click.stalePrefetch).toBe(true);
    await expect(restOf(click)).resolves.toBe("head;tail");
  });

  it("is served once: a second click on the link fetches fresh", async () => {
    const fetchMock = stubServer();
    await completedPrefetch();
    markPrefetchesStale();

    const first = await navigateToBlog(true);
    expect(first.stalePrefetch).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await navigateToBlog(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.stalePrefetch).toBe(false);
    responses[1]!.push("fresh");
    responses[1]!.end();
    await expect(restOf(second)).resolves.toBe("head;fresh");
  });

  it("adopted by a click mid-stream is not refilled once its stream ends", async () => {
    const fetchMock = stubServer();
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(10);
    markPrefetchesStale();

    const click = await navigateToBlog(true);
    expect(click.stalePrefetch).toBe(true);
    responses[0]!.push("tail");
    responses[0]!.end();
    await expect(restOf(click)).resolves.toBe("head;tail");
    await vi.advanceTimersByTimeAsync(10);

    // The slot stays empty: the next click fetches.
    expect(hasPrefetch(blogKey())).toBe(false);
    await navigateToBlog(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
