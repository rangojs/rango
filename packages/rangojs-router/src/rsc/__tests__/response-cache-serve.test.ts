/**
 * serveResponseRouteWithCache key resolution: a configured key() never falls
 * back to the broad default key (#970). The leaf must run inside
 * runWithRequestContext; without the ambient context a key() cannot run, so
 * the route runs uncached rather than caching under the default key.
 */
import { describe, expect, it, vi } from "vitest";
import { serveResponseRouteWithCache } from "../response-cache-serve.js";
import { createCacheScope, resolveCacheTags } from "../../cache/cache-scope.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { createRequestContext } from "../../server/request-context.js";
import type { EntryData } from "../../server/context.js";

describe("serveResponseRouteWithCache: a configured key()", () => {
  it("with no ambient request context, runs the route uncached, never under the default key", async () => {
    const store = new MemorySegmentCacheStore();
    const getResponse = vi.spyOn(store, "getResponse");
    const putResponse = vi.spyOn(store, "putResponse");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = new URL("http://localhost/api/data");
    const reqCtx = createRequestContext({
      env: {},
      request: new Request(url),
      url,
      variables: {},
      cacheStore: store,
    });
    // A route under cache({ ttl }) nested in cache({ key }).
    const manifestEntry = {
      type: "route",
      cache: { options: { ttl: 60 } },
      parent: {
        type: "cache",
        parent: null,
        cache: { options: { ttl: 600, key: () => "tier:gold" } },
      },
    } as unknown as EntryData;
    const executeHandler = vi.fn(async () => Response.json({ ok: true }));

    const served = await serveResponseRouteWithCache({
      reqCtx,
      manifestEntry,
      responseType: "json",
      url,
      executeHandler,
      deps: { createCacheScope, resolveCacheTags },
    });

    expect(served).toBeUndefined();
    expect(getResponse).not.toHaveBeenCalled();
    expect(putResponse).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
