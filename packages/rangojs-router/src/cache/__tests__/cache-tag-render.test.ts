import { describe, it, expect } from "vitest";
import { cacheTag, runWithCacheTagScope } from "../cache-tag.js";
import {
  runWithRequestContext,
  createRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { RangoContext } from "../../server/context.js";
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
    // the cacheTagStorage scope (only the "use cache" runtime does). So cacheTag()
    // records at the document level (_requestTags), not on the segment — the
    // documented semantic. Pin it so the contract has a test.
    const ctx = makeReqCtx();
    runWithRequestContext(ctx, () => {
      RangoContext.run({ insideCacheScope: true } as never, () => {
        cacheTag("dsl-seg-tag");
      });
    });
    expect(ctx._requestTags).toEqual(new Set(["dsl-seg-tag"]));
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
