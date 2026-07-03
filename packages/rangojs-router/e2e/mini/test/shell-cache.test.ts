import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { getRequestContext } from "@rangojs/router";
import {
  MemorySegmentCacheStore,
  createShellCacheMiddleware,
  type ShellCacheOptions,
} from "@rangojs/router/cache";
import { runMiddleware } from "@rangojs/router/testing";

// Userland dogfood of the PPR shell-cache middleware (createShellCacheMiddleware)
// through the PUBLIC testing primitive `runMiddleware`, against the REAL
// MemorySegmentCacheStore shell family (getShell/putShell). Pins the
// consumer-observable contract from docs/design/ppr-shell-resume.md:
//
//   - Only a GET for a 200 HTML document is a shell candidate; a non-HTML 200
//     is tagged MISS and never schedules a capture (bypass matrix).
//   - A fresh HTML GET is tagged x-rango-shell: MISS and its live body passes
//     through untouched.
//   - Once a shell is stored, a later GET is x-rango-shell: HIT: the cached
//     prelude bytes are flushed FIRST (frozen shell + Suspense fallback, NOT the
//     live loader content), then the resumed remainder — the live loader content
//     + the $RC stitch script + the injected __FLIGHT_DATA payload — arrives
//     later in the SAME body. The first byte does not wait on the slow loader.
//
// Harness note: the middleware calls next() EXACTLY ONCE (capture is a
// render-layer BACKGROUND task via router.match, not a second next()). This
// dogfood drives the middleware through `runMiddleware`, which does not run the
// real rsc-rendering pipeline, so the background capture cannot fire here. It
// lands the exact ShellCacheEntry the background capture writes via the public
// store.putShell, then asserts the real HIT composition (resume + compose + marker
// strip) and the MISS/bypass tagging on top of it. The full live-server
// MISS -> capture -> HIT round-trip is the cloudflare-basic and test-app e2e
// suites' job (green in dev and production; the fixture routes follow the PPR
// hole contract — loader route behind loading(), shell material in a layout —
// see docs/design/ppr-shell-resume.md "The hole contract").

// Distinctive, greppable shell vs. hole content so ordering cannot pass by luck.
const SHELL_HEADER = "Shell cache demo header";
const SUSPENSE_FALLBACK = "Loading price...";
const LOADER_CONTENT = "PRICE for #1: $19";
const STITCH_SCRIPT = "$RC";
const FLIGHT_PAYLOAD_MARKER = "__FLIGHT_DATA";

// A settled shell prelude: shell text, the Suspense fallback, the postponed hole
// template, and the closing tags React streams the remainder after (foster
// parenting). ASCII-only so btoa/atob (Latin1) round-trips exactly.
const PRELUDE_HTML =
  "<!DOCTYPE html><html><head><title>Shell cache demo</title></head><body>" +
  `<div data-testid="shell-header">${SHELL_HEADER}</div>` +
  '<!--$?--><template id="B:0"></template>' +
  `<div data-testid="price-fallback">${SUSPENSE_FALLBACK}</div><!--/$-->` +
  "</body></html>";

const POSTPONED_JSON = JSON.stringify({ nextSegmentId: 1, replaySlots: null });

// The two @internal render-orchestration flags the middleware sets on the request
// context and the real rsc-rendering branch reads. Not on the public context
// type, so the render-layer stand-in reads them through a narrow cast — the same
// fields, by the same names, production wires end to end.
interface ShellFlagsCtx {
  _shellCapture?: { key: string; ttl?: number; swr?: number; tags?: string[] };
  _shellResume?: { postponed: string | null };
}

/** base64 the prelude the way the capture branch stores it (ShellCacheEntry.prelude). */
function encodePrelude(html: string): string {
  return Buffer.from(html, "latin1").toString("base64");
}

/** The shell entry the render layer writes on a capture; landed here via putShell. */
function capturedShellEntry() {
  return {
    prelude: encodePrelude(PRELUDE_HTML),
    postponed: POSTPONED_JSON,
    reactVersion: React.version,
    createdAt: Date.now(),
  };
}

/**
 * A render-layer stand-in for next(). It mirrors the two production outcomes the
 * middleware drives via the internal flags:
 *
 *   - resume flag set -> a 200 marked x-rango-shell-resumed whose body streams
 *     ONLY the hole content + $RC + __FLIGHT_DATA, delayed by the live loader;
 *     the middleware prepends the cached prelude and strips the marker.
 *   - otherwise        -> the normal axis-1 live HTML document (the MISS pass).
 */
function makeRenderLayer(loaderDelayMs: number) {
  let holeSeq = 0;
  let calls = 0;
  const next = async (): Promise<Response> => {
    calls += 1;
    const ctx = getRequestContext() as unknown as ShellFlagsCtx;

    if (ctx._shellResume) {
      holeSeq += 1;
      const seq = holeSeq;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // The hole streams only after the live loader resolves (~loaderDelayMs);
          // the prepended prelude reaches the client long before this fires.
          setTimeout(() => {
            const remainder =
              `<div hidden id="S:0"><div data-testid="price" data-seq="${seq}">${LOADER_CONTENT}</div></div>` +
              `<script>${STITCH_SCRIPT}("B:0","S:0")</script>` +
              `<script>(self.${FLIGHT_PAYLOAD_MARKER}||=[]).push("1:live-price-${seq}")</script>`;
            controller.enqueue(new TextEncoder().encode(remainder));
            controller.close();
          }, loaderDelayMs);
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-rango-shell-resumed": "1",
        },
      });
    }

    // MISS live pass: a full axis-1 HTML document (shell + hole, inline).
    const liveDoc =
      PRELUDE_HTML.replace(
        `<div data-testid="price-fallback">${SUSPENSE_FALLBACK}</div>`,
        `<div data-testid="price" data-seq="0">${LOADER_CONTENT}</div>`,
      ) +
      `<script>(self.${FLIGHT_PAYLOAD_MARKER}||=[]).push("1:live-price-0")</script>`;
    return new Response(liveDoc, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  return { next, calls: () => calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read a whole stream: the first chunk decoded, the full body, and ms-to-first-chunk. */
async function readComposite(
  body: ReadableStream<Uint8Array>,
): Promise<{ firstChunk: string; full: string; firstChunkMs: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const t0 = performance.now();
  const first = await reader.read();
  const firstChunkMs = performance.now() - t0;
  const firstChunk = first.value
    ? decoder.decode(first.value, { stream: true })
    : "";
  let full = firstChunk;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) full += decoder.decode(value, { stream: true });
  }
  full += decoder.decode();
  return { firstChunk, full, firstChunkMs };
}

function newStore(): MemorySegmentCacheStore {
  return new MemorySegmentCacheStore({ defaults: { ttl: 60, swr: 120 } });
}

function shellMiddleware(store: MemorySegmentCacheStore) {
  const opts: ShellCacheOptions = { store, debug: false };
  return createShellCacheMiddleware(opts);
}

describe("shell-cache middleware (mini dogfood, MemorySegmentCacheStore)", () => {
  const LOADER_DELAY_MS = 350;

  afterEach(() => vi.restoreAllMocks());

  it("tags a non-HTML 200 MISS and schedules no capture (shell candidates are HTML only)", async () => {
    const store = newStore();
    const layer = makeRenderLayer(LOADER_DELAY_MS);
    const jsonNext = async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const res = await runMiddleware(shellMiddleware(store), {
      request: "http://localhost/api/thing",
      next: jsonNext,
    });

    expect(res.response.status).toBe(200);
    expect(res.headers["x-rango-shell"]).toBe("MISS");
    expect(await res.response.text()).toBe('{"ok":true}');

    // A non-HTML 200 is not a shell candidate: nothing is stored and no capture
    // re-run is scheduled (so the loader-runner double-next artifact never fires).
    await sleep(30);
    expect(await store.getShell("/api/thing:shell")).toBeNull();
    void layer; // documents intent: the layer's next() is unused on this path
  });

  it("first GET misses, then a poll flips it to HIT served shell-first and hole-later", async () => {
    // `runMiddleware` does not run the real rsc-rendering pipeline, so the
    // render-layer background capture never fires here (see the harness note up
    // top); the middleware just sets and clears the _shellCapture descriptor
    // around its single next(). Capture the console so the test can assert nothing
    // logged an unexpected error on the MISS/compose paths.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const store = newStore();
    const layer = makeRenderLayer(LOADER_DELAY_MS);
    const mw = shellMiddleware(store);
    const url = "http://localhost/shell-roundtrip";
    // The middleware host-scopes the default key: `${url.host}${pathname}:shell`.
    // The manual putShell must use the SAME key so the poll HITs.
    const key = "localhost/shell-roundtrip:shell";

    // First request: MISS, live document passes through untouched.
    const miss = await runMiddleware(mw, { request: url, next: layer.next });
    expect(miss.response.status).toBe(200);
    expect(miss.headers["x-rango-shell"]).toBe("MISS");
    expect(miss.headers["x-rango-shell-resumed"]).toBeUndefined();
    const missBody = await miss.response.text();
    expect(missBody).toContain(SHELL_HEADER);
    expect(missBody).toContain(LOADER_CONTENT); // MISS is the inline live doc

    // Land the exact shell the render-layer background capture would write via
    // the public store.putShell (runMiddleware does not run the real capture).
    await sleep(30);
    await store.putShell(key, capturedShellEntry(), 60, 120);

    // Poll (retry with timeout) until a GET returns HIT.
    let hit: Awaited<ReturnType<typeof runMiddleware>> | undefined;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const res = await runMiddleware(mw, { request: url, next: layer.next });
      if (res.headers["x-rango-shell"] === "HIT") {
        hit = res;
        break;
      }
      await sleep(20);
    }
    expect(
      hit,
      "a poll should have flipped to HIT within the timeout",
    ).toBeDefined();
    const hitRes = hit!;

    // (1) Headers: HIT set, the internal resume marker stripped, status preserved.
    expect(hitRes.response.status).toBe(200);
    expect(hitRes.headers["x-rango-shell"]).toBe("HIT");
    expect(hitRes.headers["x-rango-shell-resumed"]).toBeUndefined();

    // (2) + (4) Read the composite body incrementally.
    const { firstChunk, full, firstChunkMs } = await readComposite(
      hitRes.response.body!,
    );

    // (2) The first chunk is the frozen shell + Suspense fallback, NOT the hole.
    expect(firstChunk).toContain(SHELL_HEADER);
    expect(firstChunk).toContain(SUSPENSE_FALLBACK);
    expect(firstChunk).not.toContain(LOADER_CONTENT);

    // (2) The live loader content + the $RC stitch arrive later in the SAME body.
    expect(full).toContain(LOADER_CONTENT);
    expect(full).toContain(STITCH_SCRIPT);

    // (3) The composite carries the injected __FLIGHT_DATA hydration payload.
    expect(full).toContain(FLIGHT_PAYLOAD_MARKER);

    // (4) First byte (the prelude) does not wait on the ~350ms live loader.
    expect(firstChunkMs).toBeLessThan(LOADER_DELAY_MS);

    // Nothing on the MISS/compose paths should have logged an error (no capture
    // runs under runMiddleware, so there is no background-capture artifact either).
    expect(errorSpy.mock.calls).toEqual([]);
  });
});
