import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../browser/rango-state", () => ({
  getRangoState: () => "v1:abc",
  invalidateRangoState: vi.fn(),
}));

import { prefetchDirect, setPrefetchDecoder } from "../browser/prefetch/fetch";
import {
  buildPrefetchKey,
  clearPrefetchCache,
  hasPrefetch,
} from "../browser/prefetch/cache";
import { resetPrefetchPolicy } from "../browser/prefetch/policy";
import { abortAllPrefetches } from "../browser/prefetch/queue";
import { createNavigationClient } from "../browser/navigation-client";
import type { FetchPartialResult, RscPayload } from "../browser/types";

/**
 * A click that adopts a still-streaming prefetch owns its stream: the
 * prefetch's 30 s stall timer (executePrefetchFetch) must not abort the
 * response the navigation reads. Real prefetch fetch, cache and navigation
 * client; fetch is stubbed with browser abort semantics (an aborted signal
 * errors the body), and the decoder exposes the body's remainder as the
 * page's pending parts.
 */

const STALL_TIMEOUT_PAST = 31_000;
const SOURCE = "http://localhost:4173/current";

/** The wildcard key prefetchDirect("/blog", ..., "v1") stores under. */
const KEY = buildPrefetchKey(
  "v1:abc",
  new URL("http://localhost:4173/blog?_rsc_partial=true&_rsc_v=v1"),
);

interface ServerResponse {
  /** Send the headers (held only with `holdHeaders`). */
  respond(headers?: Record<string, string>): void;
  push(text: string): void;
  end(): void;
  readonly aborted: boolean;
}

const encoder = new TextEncoder();
let responses: ServerResponse[] = [];

/**
 * Each fetch call opens a stream that sends "head;" and stays open. Aborting
 * the request's signal rejects the fetch before its headers, and errors the
 * body after them, as a browser does.
 */
function stubServer({ holdHeaders = false } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    (_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let aborted = false;
        let closed = false;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(encoder.encode("head;"));
          },
        });
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          const error = new DOMException(
            "The request was aborted",
            "AbortError",
          );
          reject(error);
          if (!closed) controller.error(error);
        });
        const respond = (headers?: Record<string, string>) =>
          resolve(new Response(body, { headers }));
        responses.push({
          respond,
          push(text) {
            if (!aborted && !closed) controller.enqueue(encoder.encode(text));
          },
          end() {
            if (!aborted && !closed) controller.close();
            closed = true;
          },
          get aborted() {
            return aborted;
          },
        });
        if (!holdHeaders) respond();
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The root resolves with the headers; `rest` is the body still streaming. */
async function decode(responsePromise: Promise<Response>): Promise<RscPayload> {
  const response = await responsePromise;
  const rest = response.text();
  rest.catch(() => {});
  return { metadata: { isPartial: true }, rest } as unknown as RscPayload;
}

function restOf(result: FetchPartialResult): Promise<string> {
  return (result.payload as unknown as { rest: Promise<string> }).rest;
}

/** The click on the link to /blog from SOURCE. */
function clickBlog(previousUrl = SOURCE): Promise<FetchPartialResult> {
  const client = createNavigationClient({
    createFromFetch: decode,
    createFromReadableStream: vi.fn(),
  } as never);
  return client.fetchPartial({
    targetUrl: "/blog",
    previousUrl,
    segmentIds: ["A0"],
    version: "v1",
  });
}

describe("the prefetch stall timer and a click that adopted the prefetch", () => {
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

  it("does not abort a published entry adopted mid-stream: the click's stream runs to its end", async () => {
    const fetchMock = stubServer();
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hasPrefetch(KEY)).toBe(true);

    const result = await clickBlog();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_PAST);
    responses[0]!.push("tail");
    responses[0]!.end();

    await expect(restOf(result)).resolves.toBe("head;tail");
    await expect(result.streamComplete).resolves.toBeUndefined();
    expect(responses[0]!.aborted).toBe(false);
  });

  it("does not abort an in-flight prefetch the click adopted before its headers", async () => {
    const fetchMock = stubServer({ holdHeaders: true });
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(1_000);

    const clicked = clickBlog();
    await vi.advanceTimersByTimeAsync(1_000);
    responses[0]!.respond();
    const result = await clicked;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_PAST);
    responses[0]!.push("tail");
    responses[0]!.end();

    await expect(restOf(result)).resolves.toBe("head;tail");
    await expect(result.streamComplete).resolves.toBeUndefined();
    expect(responses[0]!.aborted).toBe(false);
  });

  it("still aborts and evicts a stalled prefetch nobody adopted", async () => {
    stubServer();
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hasPrefetch(KEY)).toBe(true);

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_PAST);

    expect(responses[0]!.aborted).toBe(true);
    expect(hasPrefetch(KEY)).toBe(false);
  });

  it("still aborts a prefetch the click discarded (wildcard-adopted, source-scoped)", async () => {
    const fetchMock = stubServer({ holdHeaders: true });
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(1_000);

    // From another page the source key misses, so the click adopts through
    // the wildcard alias; the answer turns out source-scoped and is dropped.
    const clicked = clickBlog("http://localhost:4173/elsewhere");
    await vi.advanceTimersByTimeAsync(1_000);
    responses[0]!.respond({ "X-RSC-Prefetch-Scope": "source" });
    await vi.advanceTimersByTimeAsync(0);
    responses[1]!.respond();
    responses[1]!.push("fresh");
    responses[1]!.end();
    const result = await clicked;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(restOf(result)).resolves.toBe("head;fresh");

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_PAST);
    expect(responses[0]!.aborted).toBe(true);
  });

  it("still bounds an adopted prefetch whose headers never arrive: the click fetches on its own", async () => {
    const fetchMock = stubServer({ holdHeaders: true });
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(1_000);

    const clicked = clickBlog();
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_PAST);
    expect(responses[0]!.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    responses[1]!.respond();
    responses[1]!.push("fresh");
    responses[1]!.end();
    const result = await clicked;
    await expect(restOf(result)).resolves.toBe("head;fresh");
  });
});
