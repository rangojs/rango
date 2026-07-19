import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../browser/rango-state", () => ({
  getRangoState: () => "v1:abc",
  invalidateRangoState: vi.fn(),
}));

import { prefetchDirect, setPrefetchDecoder } from "../browser/prefetch/fetch";
import {
  buildPrefetchKey,
  clearPrefetchCache,
  consumeInflightPrefetch,
  consumePrefetch,
  hasPrefetch,
} from "../browser/prefetch/cache";
import { resetPrefetchPolicy } from "../browser/prefetch/policy";
import { abortAllPrefetches } from "../browser/prefetch/queue";
import type { RscPayload } from "../browser/types";

/**
 * Respawnable prefetch entries: a decoded payload is single-render (its handle
 * stream drains during commit), so adoption spends the decode — but the raw
 * Flight bytes are not one-shot. executePrefetchFetch tees an unread reserve
 * branch before decoding; a cleanly-completed entry re-arms its cache slot on
 * consume by decoding the buffered bytes again. These tests exercise that
 * loop end-to-end through prefetchDirect with a real Response body, using a
 * decoder that records the bytes it received so replays are provable.
 */

const decodeMock = vi.fn(async (responsePromise: Promise<Response>) => {
  const response = await responsePromise;
  const text = await response.text();
  return { text } as unknown as RscPayload;
});

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

/** The wildcard key prefetchDirect("/blog", ..., "v1") stores under. */
const KEY = buildPrefetchKey(
  "v1:abc",
  new URL("http://localhost:4173/blog?_rsc_partial=true&_rsc_v=v1"),
);

/** Resolve once the eager decode and the completion tracking have settled. */
async function settlePrefetch(): Promise<void> {
  await vi.waitFor(() => expect(decodeMock).toHaveBeenCalled());
  await decodeMock.mock.results[decodeMock.mock.results.length - 1]!.value;
  // streamComplete resolves off the tracking tee's drain loop; two macrotask
  // turns let the drain and the allSettled respawn-arming callback run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("prefetch respawn", () => {
  beforeEach(() => {
    decodeMock.mockClear();
    setPrefetchDecoder(decodeMock as never);
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
        matchMedia: vi.fn(() => ({ matches: false }) as MediaQueryList),
      },
    });
  });

  afterEach(() => {
    clearPrefetchCache();
    abortAllPrefetches();
    resetPrefetchPolicy();
    vi.unstubAllGlobals();
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it("re-arms the slot on consume and replays the same bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("flight-bytes"))),
    );

    prefetchDirect("/blog", ["segment.a"], "v1");
    await settlePrefetch();

    const first = consumePrefetch(KEY);
    expect(first).not.toBeNull();
    expect(first!.complete).toBe(true);
    expect(first!.respawn).toBeDefined();
    await expect(first!.payload).resolves.toEqual({ text: "flight-bytes" });

    // Consuming did not empty the slot: a fresh decode of the buffered bytes
    // replaced it, and that replacement can itself respawn.
    expect(hasPrefetch(KEY)).toBe(true);
    const second = consumePrefetch(KEY);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second!.complete).toBe(true);
    await expect(second!.payload).resolves.toEqual({ text: "flight-bytes" });

    expect(hasPrefetch(KEY)).toBe(true);
    const third = consumePrefetch(KEY);
    expect(third).not.toBeNull();
    await expect(third!.payload).resolves.toEqual({ text: "flight-bytes" });

    // One eager decode + one re-arm per consume (the third consume re-arms
    // the slot again, so three consumes = three respawn decodes).
    expect(decodeMock).toHaveBeenCalledTimes(4);
    // Exactly one network request served every adoption.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("refills the slot after a mid-stream cache adoption", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(new TextEncoder().encode("head"));
      },
    });
    const fetchMock = vi.fn(() => Promise.resolve(new Response(body)));
    vi.stubGlobal("fetch", fetchMock);

    prefetchDirect("/blog", ["segment.a"], "v1");
    // Headers arrived and the entry is published, but the stream is still
    // open: one macrotask turn flushes the header-time microtask chain.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Adopt mid-stream: respawn cannot be armed yet, so this consume is
    // one-shot and the slot goes empty — the pre-refill behavior.
    const midStream = consumePrefetch(KEY);
    expect(midStream).not.toBeNull();
    expect(midStream!.complete).toBe(false);
    expect(midStream!.respawn).toBeUndefined();
    await vi.waitFor(() => expect(hasPrefetch(KEY)).toBe(false));

    // The stream the adopter is rendering finishes cleanly -> the completion
    // handler publishes a respawned sibling into the empty slot.
    controller.enqueue(new TextEncoder().encode("-tail"));
    controller.close();
    await vi.waitFor(() => expect(hasPrefetch(KEY)).toBe(true));

    const revisit = consumePrefetch(KEY);
    expect(revisit).not.toBeNull();
    expect(revisit!.complete).toBe(true);
    await expect(revisit!.payload).resolves.toEqual({ text: "head-tail" });
    // The adopted mid-stream entry also drained the full stream.
    await expect(midStream!.payload).resolves.toEqual({ text: "head-tail" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refills the slot after a pre-headers inflight adoption", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);

    prefetchDirect("/blog", ["segment.a"], "v1");
    // Adopt the in-flight promise BEFORE any response exists — the path
    // navigation takes on a hover-then-instant-click. storePrefetch will see
    // adoptedKeys and skip publication.
    const adopted = consumeInflightPrefetch(KEY);
    expect(adopted).not.toBeNull();

    resolveFetch(new Response("flight-bytes"));
    const entry = await adopted!;
    expect(entry).not.toBeNull();
    await expect(entry!.payload).resolves.toEqual({ text: "flight-bytes" });

    // Clean EOF refills the never-published slot with a respawned sibling.
    await vi.waitFor(() => expect(hasPrefetch(KEY)).toBe(true));
    const revisit = consumePrefetch(KEY);
    expect(revisit).not.toBeNull();
    expect(revisit).not.toBe(entry);
    expect(revisit!.complete).toBe(true);
    await expect(revisit!.payload).resolves.toEqual({ text: "flight-bytes" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stays one-shot when the stream did not end cleanly", async () => {
    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("connection reset"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(brokenBody))),
    );

    prefetchDirect("/blog", ["segment.a"], "v1");

    // The unclean-EOF eviction removes the published entry; nothing to adopt
    // and nothing to respawn broken bytes from.
    await vi.waitFor(() => expect(hasPrefetch(KEY)).toBe(false));
    expect(consumePrefetch(KEY)).toBeNull();
  });
});
