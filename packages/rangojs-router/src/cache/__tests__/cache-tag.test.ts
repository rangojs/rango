import { describe, it, expect } from "vitest";
import { cacheTag, runWithCacheTagScope } from "../cache-tag.js";

describe("cacheTag", () => {
  it("throws when called outside a scope", () => {
    expect(() => cacheTag("test")).toThrow(
      'cacheTag() must be called inside a "use cache" function.',
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
