/**
 * Handler-level test for where the fresh-reads cookie stops being settable
 * (issue #941): createRSCHandler marks the request context `_responseSent`
 * at the `rango.response` handoff. An updateTag() that runs later (a
 * streaming loader or render) still invalidates, but its Set-Cookie can no
 * longer reach the response, so it sets nothing and warns in dev.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Registers the shared createRSCHandler dependency mocks; must stay the first
// non-vitest import so the mocks land before ../handler.js loads.
import "./handler-test-mocks.js";

import { createRSCHandler } from "../handler.js";
import { handleResponseRoute } from "../response-route-handler.js";
import { resolveTracing } from "../../router/tracing.js";
import type { RangoInternal } from "../../router/router-interfaces.js";
import { updateTag } from "../../cache/tag-invalidation.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import {
  getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A store that reports isolate memos, so updateTag() asks for the cookie. */
function memoStore(): MemorySegmentCacheStore {
  const store = new MemorySegmentCacheStore();
  Object.defineProperty(store, "freshReadsWindowMs", { value: 10_000 });
  return store;
}

function createRouter(
  store: MemorySegmentCacheStore,
): RangoInternal<unknown, any> {
  return {
    id: "test-router",
    middleware: [],
    timeouts: { renderStartMs: 30000, actionMs: 30000 },
    debugPerformance: false,
    tracing: resolveTracing(undefined),
    resolvedStateCookieName: "rango-state_router_0",
    cache: { store },
    findMatch: vi.fn(() => ({
      entry: {},
      routeKey: "test",
      params: {},
      responseType: "json",
    })),
    previewMatch: vi.fn(async () => null),
    match: vi.fn(async () => ({
      segments: [],
      matched: [],
      diff: [],
      params: {},
    })),
    matchError: vi.fn(async () => null),
    rootLayout: undefined,
    themeConfig: undefined,
    warmupEnabled: false,
  } as any;
}

const freshCookies = (headers: Headers): string[] =>
  headers.getSetCookie().filter((cookie) => cookie.includes("-fresh="));

describe("the fresh-reads cookie at the handler's response handoff", () => {
  it("an updateTag() before the handoff sets the cookie and does not warn", async () => {
    const store = memoStore();
    let reqCtx!: RequestContext<unknown>;
    vi.mocked(handleResponseRoute).mockImplementationOnce(async () => {
      reqCtx = getRequestContext();
      await updateTag("t");
      return new Response("done", { status: 200 });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await createRSCHandler({ router: createRouter(store) })(
      new Request("https://example.com/api/data"),
      { env: {} },
    );

    expect(freshCookies(reqCtx.res.headers)).toEqual([
      "rango-state-fresh=1; Max-Age=10; Path=/; HttpOnly; SameSite=Lax; Secure",
    ]);
    expect(reqCtx._responseSent).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an updateTag() after the handoff (a streaming render) invalidates, sets no cookie, and warns", async () => {
    const store = memoStore();
    const invalidate = vi.spyOn(store, "invalidateTags");
    let reqCtx!: RequestContext<unknown>;
    let streaming!: Promise<void>;
    vi.mocked(handleResponseRoute).mockImplementationOnce(async () => {
      reqCtx = getRequestContext();
      // Work that outlives the returned Response, in the request's context.
      streaming = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
        () => updateTag("t"),
      );
      return new Response("streamed", { status: 200 });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await createRSCHandler({ router: createRouter(store) })(
      new Request("https://example.com/api/data"),
      { env: {} },
    );
    await streaming;

    expect(invalidate).toHaveBeenCalledWith(["t"]);
    expect(freshCookies(out.headers)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("after the response headers were sent"),
    );
    expect(freshCookies(reqCtx.res.headers)).toEqual([]);
    expect(reqCtx._responseSent).toBe(true);
  });
});
