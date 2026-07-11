import { describe, it, expect } from "vitest";
import { cacheTag, normalizeTag, runWithCacheTagScope } from "../cache-tag.js";
import {
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

describe("cacheTag", () => {
  it("throws when called with neither a scope nor a request context", () => {
    expect(() => cacheTag("test")).toThrow(
      'cacheTag() must be called inside a "use cache" function or during a request render.',
    );
  });

  it("collects tags inside a scope", () => {
    const { tags } = runWithCacheTagScope(() => {
      cacheTag("a", "b");
      cacheTag("c");
    });
    expect(tags).toEqual(new Set(["a", "b", "c"]));
  });

  it("deduplicates tags", () => {
    const { tags } = runWithCacheTagScope(() => {
      cacheTag("a", "b");
      cacheTag("a");
    });
    expect(tags).toEqual(new Set(["a", "b"]));
  });

  it("returns the function result", () => {
    const { result, tags } = runWithCacheTagScope(() => {
      cacheTag("x");
      return 42;
    });
    expect(result).toBe(42);
    expect(tags).toEqual(new Set(["x"]));
  });

  it("returns empty tags when none are added", () => {
    const { result, tags } = runWithCacheTagScope(() => "hello");
    expect(result).toBe("hello");
    expect(tags.size).toBe(0);
  });

  it("scopes are isolated between runs", () => {
    const { tags: tags1 } = runWithCacheTagScope(() => {
      cacheTag("first");
    });
    const { tags: tags2 } = runWithCacheTagScope(() => {
      cacheTag("second");
    });
    expect(tags1).toEqual(new Set(["first"]));
    expect(tags2).toEqual(new Set(["second"]));
  });

  it("does not reject comma tags (CF store enforces the header constraint)", () => {
    // The backend-agnostic primitive keeps commas; the comma restriction is a
    // Cloudflare Cache-Tag header concern enforced by the CF store, not here.
    const { tags } = runWithCacheTagScope(() => {
      cacheTag("a,b", "ok");
    });
    expect(tags).toEqual(new Set(["a,b", "ok"]));
  });

  it("skips empty and whitespace-only tags", () => {
    const { tags } = runWithCacheTagScope(() => {
      cacheTag("real", "", "   ", "ok");
    });
    expect(tags).toEqual(new Set(["real", "ok"]));
  });

  it("trims surrounding whitespace to the canonical form", () => {
    // normalizeTag is the single chokepoint for both the write path (cacheTag)
    // and the invalidate path (updateTag/revalidateTag). It must return the
    // TRIMMED form, otherwise " products " and "products" become two different
    // logical tags and invalidation silently misses.
    expect(normalizeTag(" products ")).toBe("products");
    expect(normalizeTag("\tproducts\n")).toBe("products");
    expect(normalizeTag("products")).toBe("products");
    expect(normalizeTag("   ")).toBeNull();
    expect(normalizeTag("")).toBeNull();
  });

  it("canonicalizes whitespace so a padded write matches an unpadded tag", () => {
    // A consumer writing cacheTag(" products ") and invalidating with
    // updateTag("products") must address the SAME stored tag. Both go through
    // normalizeTag, so the trimmed form is what is stored and looked up.
    const { tags } = runWithCacheTagScope(() => {
      cacheTag(" products ");
    });
    expect(tags).toEqual(new Set(["products"]));
  });

  it("dedupes a padded tag against its trimmed twin", () => {
    const { tags } = runWithCacheTagScope(() => {
      cacheTag("products", " products ");
    });
    expect(tags).toEqual(new Set(["products"]));
  });

  it("captures tags added after an async boundary", async () => {
    const { result, tags } = runWithCacheTagScope(() => {
      cacheTag("before");
      return (async () => {
        await Promise.resolve();
        cacheTag("after-await");
        return "done";
      })();
    });
    // Tags must be read after awaiting the result
    const value = await result;
    expect(value).toBe("done");
    expect(tags).toEqual(new Set(["before", "after-await"]));
  });
});

// Render-callable form (#648): with no "use cache" tag scope active but a
// request context present, cacheTag() records onto ctx._requestTags — the same
// request-scoped set the PPR shell capture, the document cache, and prerender
// already collect — instead of throwing. A server component that renders into a
// shell can thereby make revalidateTag() evict that shell with zero
// cache()/"use cache" in its tree.
describe("cacheTag render-callable fallback (#648)", () => {
  // A minimal request context: cacheTag only reads _getRequestContext()?._requestTags,
  // so the set is the whole surface. runWithRequestContext puts it on the ALS.
  function makeReqCtx(): RequestContext {
    return { _requestTags: new Set<string>() } as unknown as RequestContext;
  }

  it("records to _requestTags (normalized, empties skipped) with no scope but a request context", () => {
    const ctx = makeReqCtx();
    runWithRequestContext(ctx, () => {
      expect(() => cacheTag("a", " b ", "")).not.toThrow();
    });
    expect(ctx._requestTags).toEqual(new Set(["a", "b"]));
  });

  it("still throws when there is no scope AND no request context", () => {
    expect(() => cacheTag("orphan")).toThrow(
      'cacheTag() must be called inside a "use cache" function or during a request render.',
    );
  });

  it("scope wins: an active cache-tag scope records to the scope set, not _requestTags", () => {
    const ctx = makeReqCtx();
    runWithRequestContext(ctx, () => {
      const { tags } = runWithCacheTagScope(() => {
        cacheTag("scoped");
      });
      expect(tags).toEqual(new Set(["scoped"]));
    });
    // The request document artifact is NOT touched while a "use cache" scope is
    // active — the entry owns the tag, and it propagates to _requestTags on read.
    expect(ctx._requestTags.size).toBe(0);
  });
});
