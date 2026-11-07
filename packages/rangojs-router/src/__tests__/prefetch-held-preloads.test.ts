/**
 * A speculative prefetch (viewport, render) holds back the preloads of the
 * resources its page can show late, and the navigation that serves it starts
 * them (browser/prefetch/held-preloads.ts). The Flight client is React's own
 * vendored browser build; react-dom's dispatcher, which both the decode's
 * hint rows and the released `preload()` calls reach, is replaced by spies.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as ReactDOM from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../testing/internal/flight-client-globals.js";

import {
  FLIGHT_BINARY_ROW_TAGS,
  holdPreloads,
} from "../browser/prefetch/held-preloads";
import {
  prefetchDirect,
  prefetchQueued,
  setPrefetchDecoder,
} from "../browser/prefetch/fetch";
import { createPrefetchDecoder } from "../browser/prefetch/loader";
import { segmentFragment } from "../segment-fragments";
import {
  buildPrefetchKey,
  clearPrefetchCache,
  consumePrefetch,
} from "../browser/prefetch/cache";
import { abortAllPrefetches } from "../browser/prefetch/queue";
import { getRangoState } from "../browser/rango-state";
import { createNavigationClient } from "../browser/navigation-client";
import { PREFETCH_FAILED_ROW } from "../prefetch-markers";
import type { RscPayload } from "../browser/types";

const require = createRequire(import.meta.url);
const VENDOR = "@vitejs/plugin-rsc/vendor/react-server-dom/cjs";

type FlightClient = {
  createFromReadableStream: (
    stream: ReadableStream<Uint8Array>,
  ) => Promise<unknown>;
  createFromFetch: (response: Promise<Response>) => Promise<unknown>;
};
type Deps = Parameters<typeof createPrefetchDecoder>[0];

function loadClient(build: "development" | "production"): FlightClient {
  // The development build exports nothing when NODE_ENV is "production".
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = build;
  try {
    return require(
      `${VENDOR}/react-server-dom-webpack-client.browser.${build}`,
    ) as FlightClient;
  } finally {
    process.env.NODE_ENV = env;
  }
}

type Dispatcher = Record<string, (...args: unknown[]) => unknown>;
const internals = (
  ReactDOM as unknown as {
    __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
      d: Dispatcher;
    };
  }
).__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const originalDispatcher = internals.d;
let dispatcher: Record<string, ReturnType<typeof vi.fn>>;

/** The hrefs react-dom was asked to `preload`, in order. */
const preloaded = (): string[] =>
  dispatcher.L!.mock.calls.map((call) => call[0] as string);

beforeEach(() => {
  dispatcher = {};
  for (const key of Object.keys(originalDispatcher)) dispatcher[key] = vi.fn();
  internals.d = dispatcher as unknown as Dispatcher;
});

afterEach(() => {
  internals.d = originalDispatcher;
});

const LONG_TEXT = `text with a row inside\n:HL["/inside.webp","image"]\nend`;
const encoder = new TextEncoder();
const textRow = (id: string, text: string) =>
  `${id}:T${encoder.encode(text).byteLength.toString(16)},${text}`;

const HERO = `:HL["/hero.webp","image",{"fetchPriority":"high"}]\n`;
const P1 = `:HL["/p1.webp","image"]\n`;
const KEPT_HINTS = [
  `:HL["/site.css","style"]\n`,
  `:HL["/font.woff2","font",{"crossOrigin":""}]\n`,
  `:HS["/route.css","default"]\n`,
  `:Hm"/chunk.js"\n`,
  `:HC"https://cdn.example"\n`,
];

/**
 * A payload with every kind of row around the held ones. The text row comes
 * before the row that references it, as the server orders them.
 */
const SOURCE = [
  HERO,
  textRow("2", LONG_TEXT),
  `0:{"later":"$@1","text":"$2"}\n`,
  ...KEPT_HINTS,
  P1,
  `1:"value"\n`,
].join("");
const FILTERED = SOURCE.replace(HERO, "").replace(P1, "");

function streamOf(
  text: string,
  splitAt: number[] = [],
): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  const cuts = [0, ...splitAt, bytes.length];
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < cuts.length - 1; i++) {
        controller.enqueue(bytes.slice(cuts[i], cuts[i + 1]));
      }
      controller.close();
    },
  });
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function decodeAll(client: FlightClient, stream: ReadableStream) {
  const root = (await client.createFromReadableStream(stream)) as {
    later: Promise<unknown>;
    text: string;
  };
  return { later: await root.later, text: root.text };
}

describe("holdPreloads", () => {
  it("takes out the image preloads and passes every other byte, however the stream is cut", async () => {
    const length = encoder.encode(SOURCE).length;
    for (let cut = 1; cut < length; cut++) {
      const body = holdPreloads().filter(streamOf(SOURCE, [cut]));
      expect(await readText(body)).toBe(FILTERED);
    }
    const everyByte = Array.from({ length: length - 1 }, (_, i) => i + 1);
    const body = holdPreloads().filter(streamOf(SOURCE, everyByte));
    expect(await readText(body)).toBe(FILTERED);
  });

  it("passes a binary row whose bytes look like a hint row", async () => {
    // An Int8Array row ("O"): 0x0a then ':HL[...]\n' as its bytes.
    const inside = `\n:HL["/inside.webp","image"]\n`;
    const row = `3:O${encoder.encode(inside).byteLength.toString(16)},${inside}`;
    const source = `${row}0:"$3"\n`;
    expect(await readText(holdPreloads().filter(streamOf(source)))).toBe(
      source,
    );
  });

  it("keeps a failed prefetch's last row and a stream cut inside a row", async () => {
    const failed = `0:{"a":1}\n${PREFETCH_FAILED_ROW}`;
    expect(await readText(holdPreloads().filter(streamOf(failed)))).toBe(
      failed,
    );
    const truncated = `0:{"a":1}\n:HL["/hero.we`;
    expect(await readText(holdPreloads().filter(streamOf(truncated)))).toBe(
      truncated,
    );
  });

  // A row the filter reads as text when React reads it as a length-prefixed
  // binary row would let its bytes pass for rows. A React upgrade that adds a
  // binary tag fails here.
  it.each(["development", "production"] as const)(
    "names the binary row tags React's %s client reader names",
    (build) => {
      const source = readFileSync(
        require.resolve(
          `${VENDOR}/react-server-dom-webpack-client.browser.${build}`,
        ),
        "utf8",
      );
      // The byte reader's binary branch, its first in both builds:
      // `84 === rowState || 65 === rowState || ...`, up to where it enters
      // the length state (`rowState = 2`).
      const start = source.indexOf("84 === rowState");
      expect(start).toBeGreaterThan(-1);
      const branch = source.slice(start, source.indexOf("rowState = 2", start));
      const tags = [...branch.matchAll(/(\d+) === rowState/g)]
        .map((m) => String.fromCharCode(Number(m[1])))
        .join("");
      expect([...tags].sort()).toEqual([...FLIGHT_BINARY_ROW_TAGS].sort());
    },
  );

  it.each(["development", "production"] as const)(
    "React's %s client decodes the filtered stream to the same payload, and starts only the kept hints",
    async (build) => {
      const client = loadClient(build);
      const unfiltered = await decodeAll(client, streamOf(SOURCE));
      expect(preloaded()).toEqual([
        "/hero.webp",
        "/site.css",
        "/font.woff2",
        "/p1.webp",
      ]);
      const direct = dispatcher.L!.mock.calls[0];
      dispatcher.L!.mockClear();

      const held = holdPreloads();
      const body = held.filter(streamOf(SOURCE));
      expect(await decodeAll(client, body)).toEqual(unfiltered);
      expect(unfiltered).toEqual({ later: "value", text: LONG_TEXT });
      expect(preloaded()).toEqual(["/site.css", "/font.woff2"]);
      expect(dispatcher.S).toHaveBeenCalledTimes(2);
      expect(dispatcher.m).toHaveBeenCalledTimes(2);
      expect(dispatcher.C).toHaveBeenCalledTimes(2);

      dispatcher.L!.mockClear();
      held.release();
      expect(preloaded()).toEqual(["/hero.webp", "/p1.webp"]);
      // The released call reaches react-dom as the decode's would have.
      expect(dispatcher.L!.mock.calls[0]).toEqual(direct);

      held.release();
      expect(preloaded()).toEqual(["/hero.webp", "/p1.webp"]);
    },
  );

  it("starts a preload that arrives after the release as it arrives", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    // Detached, as the prefetch decoder receives `filter`.
    const { filter, release } = holdPreloads();
    const text = readText(filter(source));
    controller.enqueue(encoder.encode(`0:{"a":1}\n${HERO}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(preloaded()).toEqual([]);

    release();
    expect(preloaded()).toEqual(["/hero.webp"]);
    controller.enqueue(encoder.encode(P1));
    controller.close();
    expect(await text).toBe(`0:{"a":1}\n`);
    expect(preloaded()).toEqual(["/hero.webp", "/p1.webp"]);
  });
});

describe("a prefetch's preloads", () => {
  const client = loadClient("production");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  /**
   * The wildcard key a prefetch of /blog stores under. There is no document
   * here, so the state is the mirror's (rango-state.ts), which a cache clear
   * rotates: read it when asked.
   */
  const blogKey = (): string =>
    buildPrefetchKey(
      getRangoState(),
      new URL("http://localhost:4173/blog?_rsc_partial=true&_rsc_v=v1"),
    );
  const PAGE = `0:{"metadata":{"isPartial":true}}\n${HERO}${KEPT_HINTS[0]}`;
  // The browser app's decoder (rsc-router.tsx), over React's client.
  const deps = client as unknown as Deps;

  beforeEach(() => {
    vi.useFakeTimers();
    setPrefetchDecoder(createPrefetchDecoder(deps));
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
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(streamOf(PAGE)))),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    clearPrefetchCache();
    abortAllPrefetches();
    vi.unstubAllGlobals();
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as Record<string, unknown>).window;
  });

  /** Run the queue's idle and image waits, then let the decode finish. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.waitFor(() => expect(preloaded()).toContain("/site.css"));
    await vi.advanceTimersByTimeAsync(0);
  }

  function clickBlog() {
    return createNavigationClient({
      createFromFetch: vi.fn(() => {
        throw new Error("the click must be served by the prefetch");
      }),
      createFromReadableStream: vi.fn(),
    } as never).fetchPartial({
      targetUrl: "/blog",
      previousUrl: "http://localhost:4173/current",
      segmentIds: ["A0"],
      version: "v1",
    });
  }

  it("a speculative prefetch starts the image preload only when a click serves it", async () => {
    prefetchQueued("/blog", ["A0"], "v1");
    await settle();
    expect(preloaded()).toEqual(["/site.css"]);

    await clickBlog();
    expect(preloaded()).toEqual(["/site.css", "/hero.webp"]);
  });

  it("a speculative prefetch holds the preloads of a stored segment fragment it carries", async () => {
    // A replayed segment rides the payload as its own Flight document.
    const fragment = segmentFragment(`:HL["/p1.webp","image"]\n0:"segment"\n`);
    const payload = JSON.stringify({
      metadata: {
        isPartial: true,
        segments: [{ id: "A0", component: fragment }],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(streamOf(`0:${payload}\n${KEPT_HINTS[0]}`)),
        ),
      ),
    );
    prefetchQueued("/blog", ["A0"], "v1");
    await settle();
    const entry = consumePrefetch(blogKey())!;
    const decoded = (await entry.payload) as unknown as {
      metadata: { segments: { component: unknown }[] };
    };
    expect(decoded.metadata.segments[0]!.component).toBe("segment");
    expect(preloaded()).toEqual(["/site.css"]);

    entry.heldPreloads!.release();
    expect(preloaded()).toEqual(["/site.css", "/p1.webp"]);
  });

  it("an intent prefetch starts a fragment's preloads as it decodes", async () => {
    const fragment = segmentFragment(`:HL["/p1.webp","image"]\n0:"segment"\n`);
    const payload = JSON.stringify({
      metadata: {
        isPartial: true,
        segments: [{ id: "A0", component: fragment }],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(streamOf(`0:${payload}\n${KEPT_HINTS[0]}`)),
        ),
      ),
    );
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.waitFor(() => expect(preloaded()).toContain("/p1.webp"));
  });

  it("a click that adopts a speculative prefetch still streaming starts its later preloads as they arrive", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(encoder.encode(`0:{"metadata":{"isPartial":true}}\n`));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(body))),
    );
    prefetchQueued("/blog", ["A0"], "v1");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetch).toHaveBeenCalledTimes(1);

    await clickBlog();
    expect(preloaded()).toEqual([]);
    controller.enqueue(encoder.encode(HERO));
    controller.close();
    await vi.waitFor(() => expect(preloaded()).toEqual(["/hero.webp"]));
  });

  it("a respawn of a speculative prefetch holds them too", async () => {
    prefetchQueued("/blog", ["A0"], "v1");
    await settle();
    // Consuming re-arms the slot with a fresh decode of the same bytes.
    const first = consumePrefetch(blogKey());
    await first!.payload;
    await vi.advanceTimersByTimeAsync(0);
    // The respawn's decode starts the kept preload again (react-dom dedupes
    // it in a page; the spy does not) and the held one not at all.
    expect(preloaded()).toEqual(["/site.css", "/site.css"]);
    const second = consumePrefetch(blogKey())!;
    expect(second).not.toBe(first);
    expect(second.heldPreloads).toBe(first!.heldPreloads);
    second.heldPreloads!.release();
    expect(preloaded()).toEqual(["/site.css", "/site.css", "/hero.webp"]);
  });

  it("an intent prefetch (hover) starts them as it decodes", async () => {
    prefetchDirect("/blog", ["A0"], "v1");
    await vi.waitFor(() => expect(preloaded()).toContain("/site.css"));
    expect(preloaded()).toEqual(["/hero.webp", "/site.css"]);
  });
});
