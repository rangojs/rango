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
 * A loader that throws during a prefetch answers 200 with its error inside
 * the payload. The entry is marked `failed` instead of `complete`: it arms no
 * respawn, refills no slot after an early adoption, and keeps its slot until
 * a click consumes it (navigation-client.ts then refetches with no-store).
 */

const ERROR_RESULT = {
  __loaderResult: true,
  ok: false,
  error: { message: "stock service unavailable", name: "Error" },
  fallback: null,
};
const OK_RESULT = { __loaderResult: true, ok: true, data: { value: 1 } };
const REDIRECT_RESULT = {
  __loaderResult: true,
  ok: false,
  redirect: { to: "/ok" },
};

let loaderResult: unknown = ERROR_RESULT;
let deferred = false;

/** Decodes the body as a payload with one loader segment (`loaderResult`). */
const decodeMock = vi.fn(async (responsePromise: Promise<Response>) => {
  const response = await responsePromise;
  const text = await response.text();
  return {
    text,
    metadata: {
      segments: [
        { id: "M0L0", type: "layout" },
        {
          id: "M0L0D0.stock",
          type: "loader",
          loaderData: Promise.resolve(loaderResult),
          ...(deferred && { deferred: true }),
        },
      ],
    },
  } as unknown as RscPayload;
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

/** Resolve once the eager decode and the completion check have settled. */
async function settlePrefetch(): Promise<void> {
  await vi.waitFor(() => expect(decodeMock).toHaveBeenCalled());
  await decodeMock.mock.results[decodeMock.mock.results.length - 1]!.value;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a prefetch that finished with a loader error", () => {
  beforeEach(() => {
    loaderResult = ERROR_RESULT;
    deferred = false;
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

  it("is marked failed, not complete, arms no respawn, and holds its slot until a click consumes it", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("bytes")));
    vi.stubGlobal("fetch", fetchMock);

    prefetchDirect("/blog", ["segment.a"], "v1");
    await settlePrefetch();

    // The slot stays taken: a second hover does not prefetch the same URL
    // again (it would read the same 200 back from the HTTP cache).
    expect(hasPrefetch(KEY)).toBe(true);
    prefetchDirect("/blog", ["segment.a"], "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const entry = consumePrefetch(KEY);
    expect(entry).not.toBeNull();
    // Consumed once, the slot is clear: nothing replays the error.
    expect(hasPrefetch(KEY)).toBe(false);
    expect(consumePrefetch(KEY)).toBeNull();
    expect(entry!.respawn).toBeUndefined();
    expect(entry!.complete).toBe(false);
    expect(entry!.failed).toBe(true);
  });

  it("refills no slot after a pre-headers inflight adoption", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);

    prefetchDirect("/blog", ["segment.a"], "v1");
    // The click adopts the stream as before; the error is current for it.
    const adopted = consumeInflightPrefetch(KEY);
    expect(adopted).not.toBeNull();
    resolveFetch(new Response("bytes"));
    const entry = await adopted!;
    expect(entry).not.toBeNull();
    await settlePrefetch();

    expect(hasPrefetch(KEY)).toBe(false);
    expect(consumePrefetch(KEY)).toBeNull();
    expect(entry!.failed).toBe(true);
  });

  it("refills no slot after a mid-stream cache adoption", async () => {
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
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const midStream = consumePrefetch(KEY);
    expect(midStream).not.toBeNull();
    expect(midStream!.complete).toBe(false);

    controller.enqueue(new TextEncoder().encode("-tail"));
    controller.close();
    await settlePrefetch();

    expect(hasPrefetch(KEY)).toBe(false);
    expect(midStream!.failed).toBe(true);
  });

  it.each([
    ["a loader that answered", () => (loaderResult = OK_RESULT)],
    ["a loader redirect()", () => (loaderResult = REDIRECT_RESULT)],
    ["a prefetch: false loader the prefetch deferred", () => (deferred = true)],
  ])(
    "%s is not a failure: the entry completes and respawns",
    async (_, setup) => {
      setup();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(new Response("bytes"))),
      );

      prefetchDirect("/blog", ["segment.a"], "v1");
      await settlePrefetch();

      const entry = consumePrefetch(KEY);
      expect(entry).not.toBeNull();
      expect(entry!.failed).toBeUndefined();
      expect(entry!.complete).toBe(true);
      expect(entry!.respawn).toBeDefined();
      expect(hasPrefetch(KEY)).toBe(true);
    },
  );
});
