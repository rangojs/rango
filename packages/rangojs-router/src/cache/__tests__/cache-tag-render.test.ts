import { describe, it, expect, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  cacheTag,
  getSegmentTags,
  linkLoaderTags,
  recordLoaderTags,
  runInSegmentTagScope,
  runWithCacheTagScope,
} from "../cache-tag.js";
import {
  runWithRequestContext,
  createRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import {
  RangoContext,
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
} from "../../server/context.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { updateTag } from "../tag-invalidation.js";
import type { ShellCacheEntry, SegmentCacheStore } from "../types.js";

// Extensive coverage for the render-callable cacheTag() form (#648): the second
// form of cacheTag() records onto the request's document tag set (ctx._requestTags)
// when there is no "use cache" tag scope active but a request context is present.
// The pure-semantics cases here complement the capture-integration cases in
// rsc/__tests__/shell-capture.test.ts and the document-cache cases in
// document-cache.test.ts.

const NO_CONTEXT_MESSAGE =
  'cacheTag() must be called inside a "use cache" function or during a request render.';

/** A minimal request context — cacheTag reads only _getRequestContext()?._requestTags. */
function makeReqCtx(extra?: Record<string, unknown>): RequestContext {
  return {
    _requestTags: new Set<string>(),
    ...extra,
  } as unknown as RequestContext;
}

describe("cacheTag() error-message contract (#648)", () => {
  it("throws the documented message verbatim with neither a scope nor a request context", () => {
    // Consumers see this string; pin it exactly.
    expect(() => cacheTag("x")).toThrowError(NO_CONTEXT_MESSAGE);
  });
});

describe("cacheTag() normalization parity across both forms (#648)", () => {
  // Collect the tags the two forms accumulate for the SAME sequence of calls.
  function collectInScope(fn: () => void): Set<string> {
    return runWithCacheTagScope(fn).tags;
  }
  function collectInRequest(fn: () => void): Set<string> {
    const ctx = makeReqCtx();
    runWithRequestContext(ctx, fn);
    return ctx._requestTags;
  }

  const forms: Array<[string, (fn: () => void) => Set<string>]> = [
    ["use-cache scope", collectInScope],
    ["render-callable request", collectInRequest],
  ];

  for (const [label, collect] of forms) {
    it(`${label}: trims, drops empty/whitespace, dedupes, accumulates across calls`, () => {
      const tags = collect(() => {
        cacheTag("a", " b ", "");
        cacheTag("a", "   ", "c");
      });
      // trim (" b " -> "b"), empty/whitespace dropped, "a" deduped, calls accumulate.
      expect(tags).toEqual(new Set(["a", "b", "c"]));
    });
  }
});

describe("cacheTag() scope vs request routing (#648)", () => {
  it("routes to the scope set inside a use-cache scope, back to _requestTags after it exits — neither leaks", () => {
    const ctx = makeReqCtx();
    let scopeTags: Set<string> | undefined;
    runWithRequestContext(ctx, () => {
      cacheTag("before-render");
      const { tags } = runWithCacheTagScope(() => {
        cacheTag("in-scope");
      });
      scopeTags = tags;
      // Back at the render level (scope exited) — routes to _requestTags again.
      cacheTag("after-render");
    });
    expect(scopeTags).toEqual(new Set(["in-scope"]));
    expect(ctx._requestTags).toEqual(
      new Set(["before-render", "after-render"]),
    );
    // No cross-leak in either direction.
    expect(ctx._requestTags.has("in-scope")).toBe(false);
    expect(scopeTags!.has("before-render")).toBe(false);
    expect(scopeTags!.has("after-render")).toBe(false);
  });

  it("records at the DOCUMENT level inside a cache() DSL segment (isInsideCacheScope true, no tag scope)", () => {
    // A cache() DSL boundary sets RangoContext.insideCacheScope but does NOT enter
    // the cacheTagStorage scope (only the "use cache" runtime does), so cacheTag()
    // records on the document set (_requestTags). The route's cache() record
    // picks it up through the segment tag scope instead (#957, below).
    const ctx = makeReqCtx();
    runWithRequestContext(ctx, () => {
      RangoContext.run({ insideCacheScope: true } as never, () => {
        cacheTag("dsl-seg-tag");
      });
    });
    expect(ctx._requestTags).toEqual(new Set(["dsl-seg-tag"]));
  });
});

describe("render-called tags attributed to their segment (#957)", () => {
  it("records on the document set AND the segment's set inside its tag scope", async () => {
    const ctx = makeReqCtx({ _recordTagOwners: true });
    await runWithRequestContext(ctx, () =>
      runInSegmentTagScope("L0", async () => {
        cacheTag("sync-tag");
        await Promise.resolve();
        cacheTag("after-await-tag");
      }),
    );
    expect(ctx._requestTags).toEqual(new Set(["sync-tag", "after-await-tag"]));
    expect(getSegmentTags(ctx, "L0")).toEqual(
      new Set(["sync-tag", "after-await-tag"]),
    );
  });

  it("gives a loader's tags to the segment only when the segment consumes the loader, whoever started it", () => {
    const ctx = makeReqCtx({ _recordTagOwners: true });
    runWithRequestContext(ctx, () => {
      // Loader bodies started outside any segment (the DSL funnel), before
      // the handler.
      runInsideLoaderBodyScope(() => cacheTag("consumed-tag"), "test#Consumed");
      runInsideLoaderBodyScope(() => cacheTag("unread-tag"), "test#Unread");
      // The handler reads one of them (ctx.use).
      runInSegmentTagScope("L0", () => linkLoaderTags("test#Consumed"));
    });
    expect(ctx._requestTags).toEqual(new Set(["consumed-tag", "unread-tag"]));
    expect(getSegmentTags(ctx, "L0")).toEqual(new Set(["consumed-tag"]));
  });

  it("follows a consumed loader's own reads (loader-to-loader), cycles included", () => {
    const ctx = makeReqCtx({ _recordTagOwners: true });
    runWithRequestContext(ctx, () => {
      runInsideLoaderBodyScope(() => {
        cacheTag("a-tag");
        linkLoaderTags("test#B");
      }, "test#A");
      runInsideLoaderBodyScope(() => {
        cacheTag("b-tag");
        linkLoaderTags("test#A");
      }, "test#B");
      runInSegmentTagScope("L0", () => linkLoaderTags("test#A"));
    });
    expect(getSegmentTags(ctx, "L0")).toEqual(new Set(["a-tag", "b-tag"]));
  });

  it("does not treat the DSL funnel starting a loader as a consumption", () => {
    const ctx = makeReqCtx({ _recordTagOwners: true });
    runWithRequestContext(ctx, () => {
      recordLoaderTags("test#Dsl", ["dsl-tag"]);
      runInSegmentTagScope("L0", () =>
        runInsideLoaderScope(() => linkLoaderTags("test#Dsl")),
      );
    });
    expect(getSegmentTags(ctx, "L0")).toEqual(new Set());
  });

  it("keeps each request context's segment sets apart (a capture's derived context)", () => {
    const foreground = makeReqCtx({ _recordTagOwners: true });
    const derived = Object.create(foreground) as RequestContext;
    derived._requestTags = new Set<string>();

    runWithRequestContext(foreground, () =>
      runInSegmentTagScope("L0", () => cacheTag("fg-tag")),
    );
    runWithRequestContext(derived, () =>
      runInSegmentTagScope("L0", () => cacheTag("capture-tag")),
    );

    expect(getSegmentTags(foreground, "L0")).toEqual(new Set(["fg-tag"]));
    expect(getSegmentTags(derived, "L0")).toEqual(new Set(["capture-tag"]));
  });

  it("records no owners and enters no scope on a request that cannot write a record", () => {
    const ctx = makeReqCtx();
    const run = vi.spyOn(AsyncLocalStorage.prototype, "run");
    try {
      runWithRequestContext(ctx, () => {
        run.mockClear();
        runInsideLoaderBodyScope(() => cacheTag("loader-tag"), "test#Unarmed");
        runInSegmentTagScope("L0", () => {
          linkLoaderTags("test#Unarmed");
          cacheTag("segment-tag");
        });
        // Only the loader body scope (server/context.ts) ran; no tag scope.
        expect(run).toHaveBeenCalledTimes(1);
      });
    } finally {
      run.mockRestore();
    }
    expect(ctx._requestTags).toEqual(new Set(["loader-tag", "segment-tag"]));
    expect(getSegmentTags(ctx, "L0")).toEqual(new Set());
  });
});

describe("cacheTag() capture/foreground context isolation (#648)", () => {
  it("a tag recorded on a capture-derived context does not leak to the foreground set, and vice versa", () => {
    // Mirrors shell-capture.ts:712-714 — the capture runs in a derived context
    // (Object.create(reqCtx)) with its OWN fresh _requestTags. Tags recorded
    // during capture belong to the shell; foreground tags belong to the served
    // document. They must not cross.
    const foreground = makeReqCtx();
    foreground._requestTags.add("fg-preexisting");
    const derived = Object.create(foreground) as RequestContext;
    derived._requestTags = new Set<string>();

    runWithRequestContext(derived, () => cacheTag("capture-tag"));
    runWithRequestContext(foreground, () => cacheTag("fg-tag"));

    expect(derived._requestTags).toEqual(new Set(["capture-tag"]));
    expect(foreground._requestTags).toEqual(
      new Set(["fg-preexisting", "fg-tag"]),
    );
    expect(foreground._requestTags.has("capture-tag")).toBe(false);
    expect(derived._requestTags.has("fg-tag")).toBe(false);
    // The derived set is fresh, NOT the prototype's — inherited tags never appear.
    expect(derived._requestTags.has("fg-preexisting")).toBe(false);
  });
});

describe("cacheTag() under a build-time (prerender) context (#648)", () => {
  it("records into a prerender-shaped context's _requestTags", () => {
    // The prerender build contexts seed a fresh _requestTags set
    // (prerender-match.ts:221,476). The render-callable form works identically
    // under build-time collection, so a component that cacheTag()s pre-renders the
    // same eviction contract it would serve at runtime.
    const buildCtx = makeReqCtx({ build: true });
    runWithRequestContext(buildCtx, () => cacheTag("prerender-tag"));
    expect(buildCtx._requestTags).toEqual(new Set(["prerender-tag"]));
  });
});

describe("cacheTag() eviction round-trip through updateTag (#648)", () => {
  function makeStoreCtx(store: SegmentCacheStore): RequestContext {
    return createRequestContext({
      env: {},
      request: new Request("http://localhost/"),
      url: new URL("http://localhost/"),
      variables: {},
      cacheStore: store,
    }) as RequestContext;
  }

  it("a render-recorded tag makes a shell entry evictable by updateTag", async () => {
    const store = new MemorySegmentCacheStore();
    const ctx = makeStoreCtx(store);
    await runWithRequestContext(ctx, async () => {
      // A server component records the tag with no "use cache" scope.
      cacheTag("shell-op");
      // The capture stores the shell tagged with the collected _requestTags.
      const entry: ShellCacheEntry = {
        prelude: "<html></html>",
        postponed: null,
        reactVersion: "19",
        buildVersion: "test-build",
        snapshot: [],
        createdAt: Date.now(),
      };
      await store.putShell("k", entry, 300, 120, [...ctx._requestTags]);
      expect(await store.getShell("k")).not.toBeNull();

      // updateTag drops the shell tagged by the render — with zero cache()/"use
      // cache" in the tree.
      await updateTag("shell-op");
      expect(await store.getShell("k")).toBeNull();
    });
  });

  it("a render-recorded tag makes a document (response) entry evictable by updateTag", async () => {
    const store = new MemorySegmentCacheStore();
    const ctx = makeStoreCtx(store);
    await runWithRequestContext(ctx, async () => {
      cacheTag("doc-op");
      await store.putResponse(
        "d",
        new Response("body", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
        60,
        300,
        [...ctx._requestTags],
      );
      expect(await store.getResponse("d")).not.toBeNull();

      await updateTag("doc-op");
      expect(await store.getResponse("d")).toBeNull();
    });
  });
});
