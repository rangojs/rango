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
import { PREFETCH_FAILED_ROW } from "../prefetch-markers";
import type { RscPayload } from "../browser/types";

/**
 * A prefetch whose render reported an error ends with PREFETCH_FAILED_ROW
 * (rsc/prefetch-render-error.ts; a loader error is one, #1170). It counts as
 * a stream that did not end cleanly: evicted, never complete, never
 * respawned, so the click and the next hover reach the server (prefetch
 * responses carry no Cache-Control). A click that adopted it keeps the
 * payload it adopted.
 */

const encoder = new TextEncoder();

/** Decodes the body as a payload; the marker row is skipped by React. */
const decodeMock = vi.fn(async (responsePromise: Promise<Response>) => {
  const response = await responsePromise;
  return { text: await response.text() } as unknown as RscPayload;
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

/** A body of `chunks`, ended cleanly. */
function body(...chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  );
}

/** Resolve once the eager decode and the completion check have settled. */
async function settlePrefetch(): Promise<void> {
  await vi.waitFor(() => expect(decodeMock).toHaveBeenCalled());
  await decodeMock.mock.results[decodeMock.mock.results.length - 1]!.value;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a prefetch whose render reported an error", () => {
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

  it.each([
    ["in its own chunk", ["0:{}\n", PREFETCH_FAILED_ROW]],
    ["at the end of the last chunk", [`0:{}\n${PREFETCH_FAILED_ROW}`]],
    ["split across chunks", ["0:{}\n:H", "_", "0\n"]],
  ])(
    "ending with the row %s, it is evicted, never served and never respawned; the next hover asks the server",
    async (_, chunks) => {
      expect(chunks.join("").endsWith(PREFETCH_FAILED_ROW)).toBe(true);
      const fetchMock = vi.fn(() => Promise.resolve(body(...chunks)));
      vi.stubGlobal("fetch", fetchMock);

      prefetchDirect("/blog", ["segment.a"], "v1");
      await settlePrefetch();

      expect(hasPrefetch(KEY)).toBe(false);
      expect(consumePrefetch(KEY)).toBeNull();

      prefetchDirect("/blog", ["segment.a"], "v1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("a click that adopted it before its headers keeps the payload; no slot is refilled", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);

    prefetchDirect("/blog", ["segment.a"], "v1");
    const adopted = consumeInflightPrefetch(KEY);
    expect(adopted).not.toBeNull();
    resolveFetch(body("0:{}\n", PREFETCH_FAILED_ROW));
    const entry = await adopted!;
    expect(entry).not.toBeNull();
    await settlePrefetch();

    expect(await entry!.payload).toEqual({
      text: `0:{}\n${PREFETCH_FAILED_ROW}`,
    });
    expect(entry!.complete).toBe(false);
    expect(entry!.respawn).toBeUndefined();
    expect(hasPrefetch(KEY)).toBe(false);
  });

  it("a click that adopted it mid-stream keeps the payload; no slot is refilled", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(encoder.encode("0:{}\n"));
      },
    });
    const fetchMock = vi.fn(() => Promise.resolve(new Response(stream)));
    vi.stubGlobal("fetch", fetchMock);

    prefetchDirect("/blog", ["segment.a"], "v1");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const midStream = consumePrefetch(KEY);
    expect(midStream).not.toBeNull();
    expect(midStream!.complete).toBe(false);

    controller.enqueue(encoder.encode(PREFETCH_FAILED_ROW));
    controller.close();
    await settlePrefetch();

    expect(midStream!.complete).toBe(false);
    expect(midStream!.respawn).toBeUndefined();
    expect(hasPrefetch(KEY)).toBe(false);
  });

  it("a healthy prefetch, whatever its loaders answered, completes and respawns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(body("0:{}\n", "1:{}\n"))),
    );

    prefetchDirect("/blog", ["segment.a"], "v1");
    await settlePrefetch();

    const entry = consumePrefetch(KEY);
    expect(entry).not.toBeNull();
    expect(entry!.complete).toBe(true);
    expect(entry!.respawn).toBeDefined();
    expect(hasPrefetch(KEY)).toBe(true);
  });
});
