import { describe, it, expect } from "vitest";
import {
  findMatchingParenInBundle,
  extractHandlerExportsFromChunk,
  evictHandlerCode,
} from "../utils/bundle-analysis.js";

// ---------------------------------------------------------------------------
// findMatchingParenInBundle
// ---------------------------------------------------------------------------

describe("findMatchingParenInBundle", () => {
  it("finds simple closing paren", () => {
    const code = "fn(a, b)";
    // openParenPos = 3 means we start after the '('
    expect(findMatchingParenInBundle(code, 3)).toBe(8);
  });

  it("handles nested parens", () => {
    const code = "fn(a(b), c)";
    expect(findMatchingParenInBundle(code, 3)).toBe(11);
  });

  it("skips parens inside double-quoted strings", () => {
    const code = `fn("(", b)`;
    expect(findMatchingParenInBundle(code, 3)).toBe(10);
  });

  it("skips parens inside single-quoted strings", () => {
    const code = "fn(')', b)";
    expect(findMatchingParenInBundle(code, 3)).toBe(10);
  });

  it("skips parens inside template literals", () => {
    const code = "fn(`(`, b)";
    expect(findMatchingParenInBundle(code, 3)).toBe(10);
  });

  it("handles template literals with ${} expressions", () => {
    const code = "fn(`${foo(1)}`, b)";
    expect(findMatchingParenInBundle(code, 3)).toBe(18);
  });

  it("skips parens inside single-line comments", () => {
    const code = "fn(// (\nb)";
    expect(findMatchingParenInBundle(code, 3)).toBe(10);
  });

  it("skips parens inside multi-line comments", () => {
    const code = "fn(/* ( */ b)";
    expect(findMatchingParenInBundle(code, 3)).toBe(13);
  });

  it("returns -1 for unmatched paren", () => {
    const code = "fn(a, b";
    expect(findMatchingParenInBundle(code, 3)).toBe(-1);
  });

  it("handles deeply nested structures", () => {
    const code = "fn(a(b(c(d))))";
    expect(findMatchingParenInBundle(code, 3)).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// extractHandlerExportsFromChunk
// ---------------------------------------------------------------------------

describe("extractHandlerExportsFromChunk", () => {
  it("extracts handler with $$id assignment", () => {
    const chunk = [
      `const myLoader = createLoader({ fetch() { return null; } });`,
      `myLoader.$$id = "abc12345#myLoader";`,
    ].join("\n");
    const modules = new Map([["src/loaders.ts", ["myLoader"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "createLoader",
      false,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "myLoader",
      handlerId: "abc12345#myLoader",
      passthrough: false,
      onDemand: false,
    });
  });

  it("detects an onDemand: true literal", () => {
    const chunk = [
      `const Page = Prerender(() => null, { onDemand: !0 });`,
      `Page.$$id = "abc12345#Page";`,
    ].join("\n");
    const modules = new Map([["src/pages.ts", ["Page"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "Prerender",
      false,
      true,
    );
    expect(result[0].onDemand).toBe(true);
    expect(result[0].passthrough).toBe(false);
  });

  it("detects an onDemand object literal", () => {
    const chunk = [
      `const Page = Prerender(() => null, { onDemand: { ttl: 60 } });`,
      `Page.$$id = "abc12345#Page";`,
    ].join("\n");
    const modules = new Map([["src/pages.ts", ["Page"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "Prerender",
      false,
      true,
    );
    expect(result[0].onDemand).toBe(true);
  });

  it("does NOT flag onDemand for `onDemand: false` (opt-out, not a literal opt-in)", () => {
    const chunk = [
      `const Page = Prerender(() => null, { onDemand: !1 });`,
      `Page.$$id = "abc12345#Page";`,
    ].join("\n");
    const modules = new Map([["src/pages.ts", ["Page"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "Prerender",
      false,
      true,
    );
    expect(result[0].onDemand).toBe(false);
  });

  it("does NOT flag onDemand for a ternary `x ? onDemand : y` in the body", () => {
    const chunk = [
      `const Page = Prerender(() => (cond ? onDemand : fallback));`,
      `Page.$$id = "abc12345#Page";`,
    ].join("\n");
    const modules = new Map([["src/pages.ts", ["Page"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "Prerender",
      false,
      true,
    );
    expect(result[0].onDemand).toBe(false);
  });

  it("reports onDemand: false when detection is off", () => {
    const chunk = [
      `const Page = Prerender(() => null, { onDemand: true });`,
      `Page.$$id = "abc12345#Page";`,
    ].join("\n");
    const modules = new Map([["src/pages.ts", ["Page"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "Prerender",
      false,
    );
    expect(result[0].onDemand).toBe(false);
  });

  it("skips handler without $$id assignment", () => {
    const chunk = `const myLoader = createLoader({ fetch() { return null; } });`;
    const modules = new Map([["src/loaders.ts", ["myLoader"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "createLoader",
      false,
    );
    expect(result).toHaveLength(0);
  });

  it("detects passthrough flag when enabled", () => {
    const chunk = [
      `const myHandler = Static({ passthrough: !0, fetch() {} });`,
      `myHandler.$$id = "abc12345#myHandler";`,
    ].join("\n");
    const modules = new Map([["src/handlers.ts", ["myHandler"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "Static",
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].passthrough).toBe(true);
  });

  it("detects passthrough: true", () => {
    const chunk = [
      `const myHandler = Static({ passthrough: true, fetch() {} });`,
      `myHandler.$$id = "abc12345#myHandler";`,
    ].join("\n");
    const modules = new Map([["src/handlers.ts", ["myHandler"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "Static",
      true,
    );
    expect(result[0].passthrough).toBe(true);
  });

  it("handles $-prefixed handler names", () => {
    const chunk = [
      `const $Nav = createLoader({ fetch() { return null; } });`,
      `$Nav.$$id = "abc12345#$Nav";`,
    ].join("\n");
    const modules = new Map([["src/nav.ts", ["$Nav"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "createLoader",
      false,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("$Nav");
    expect(result[0].handlerId).toBe("abc12345#$Nav");
  });

  it("handles generic type parameters on function call", () => {
    const chunk = [
      `const myLoader = createLoader<{ id: string }>({ fetch() {} });`,
      `myLoader.$$id = "abc12345#myLoader";`,
    ].join("\n");
    const modules = new Map([["src/loaders.ts", ["myLoader"]]]);
    const result = extractHandlerExportsFromChunk(
      chunk,
      modules,
      "createLoader",
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].passthrough).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evictHandlerCode
// ---------------------------------------------------------------------------

describe("evictHandlerCode", () => {
  // Note: In real bundled code, the expose-internal-ids plugin injects $$id
  // into the first argument of createLoader/createHandle/Static. The handlerId
  // validation check expects it to appear inside the call range.

  it("replaces handler call with stub", () => {
    const code = [
      `const myLoader = createLoader({$$id: "abc12345#myLoader", fetch() { return { data: 1 }; } });`,
      `myLoader.$$id = "abc12345#myLoader";`,
    ].join("\n");
    const result = evictHandlerCode(
      code,
      [{ name: "myLoader", handlerId: "abc12345#myLoader" }],
      "createLoader",
      "loader",
    );
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      `const myLoader = { __brand: "loader", $$id: "abc12345#myLoader" };`,
    );
    // The $$id assignment line should be removed
    expect(result!.code).not.toContain(`myLoader.$$id`);
    expect(result!.savedBytes).toBeGreaterThan(0);
  });

  it("skips passthrough handlers", () => {
    const code = [
      `const myHandler = Static({$$id: "abc12345#myHandler", passthrough: true, fetch() {} });`,
      `myHandler.$$id = "abc12345#myHandler";`,
    ].join("\n");
    const result = evictHandlerCode(
      code,
      [
        {
          name: "myHandler",
          handlerId: "abc12345#myHandler",
          passthrough: true,
        },
      ],
      "Static",
      "static",
    );
    expect(result).toBeNull();
  });

  it("skips onDemand handlers (retains the producer body)", () => {
    const code = [
      `const Page = Prerender({$$id: "abc12345#Page", fetch() {} });`,
      `Page.$$id = "abc12345#Page";`,
    ].join("\n");
    const result = evictHandlerCode(
      code,
      [{ name: "Page", handlerId: "abc12345#Page", onDemand: true }],
      "Prerender",
      "prerenderHandler",
    );
    expect(result).toBeNull();
  });

  it("returns null when no handlers match", () => {
    const code = `const unrelated = someOtherCall();`;
    const result = evictHandlerCode(
      code,
      [{ name: "myLoader", handlerId: "abc12345#myLoader" }],
      "createLoader",
      "loader",
    );
    expect(result).toBeNull();
  });

  it("validates handlerId is in the matched range", () => {
    // Handler code contains a different handlerId than expected
    const code = [
      `const myLoader = createLoader({$$id: "different#id", fetch() { return null; } });`,
      `myLoader.$$id = "different#id";`,
    ].join("\n");
    const result = evictHandlerCode(
      code,
      [{ name: "myLoader", handlerId: "abc12345#myLoader" }],
      "createLoader",
      "loader",
    );
    expect(result).toBeNull();
  });

  it("handles multiple handlers in one chunk", () => {
    const code = [
      `const loaderA = createLoader({$$id: "hash1#loaderA", fetch() { return { a: 1 }; } });`,
      `loaderA.$$id = "hash1#loaderA";`,
      `const loaderB = createLoader({$$id: "hash2#loaderB", fetch() { return { b: 2 }; } });`,
      `loaderB.$$id = "hash2#loaderB";`,
    ].join("\n");
    const result = evictHandlerCode(
      code,
      [
        { name: "loaderA", handlerId: "hash1#loaderA" },
        { name: "loaderB", handlerId: "hash2#loaderB" },
      ],
      "createLoader",
      "loader",
    );
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      `const loaderA = { __brand: "loader", $$id: "hash1#loaderA" };`,
    );
    expect(result!.code).toContain(
      `const loaderB = { __brand: "loader", $$id: "hash2#loaderB" };`,
    );
  });

  it("handles $-prefixed handler names via escapeRegExp", () => {
    const code = [
      `const $Nav = createLoader({$$id: "abc12345#$Nav", fetch() { return null; } });`,
      `$Nav.$$id = "abc12345#$Nav";`,
    ].join("\n");
    const result = evictHandlerCode(
      code,
      [{ name: "$Nav", handlerId: "abc12345#$Nav" }],
      "createLoader",
      "loader",
    );
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      `const $Nav = { __brand: "loader", $$id: "abc12345#$Nav" };`,
    );
    expect(result!.code).not.toContain(`$Nav.$$id`);
  });

  it("does not match prefix handler names", () => {
    // "Article" should not match "ArticleDetail"
    const code = [
      `const Article = createLoader({$$id: "hash1#Article", fetch() {} });`,
      `Article.$$id = "hash1#Article";`,
      `const ArticleDetail = createLoader({$$id: "hash2#ArticleDetail", fetch() {} });`,
      `ArticleDetail.$$id = "hash2#ArticleDetail";`,
    ].join("\n");
    // Only evict Article, not ArticleDetail
    const result = evictHandlerCode(
      code,
      [{ name: "Article", handlerId: "hash1#Article" }],
      "createLoader",
      "loader",
    );
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      `const Article = { __brand: "loader", $$id: "hash1#Article" };`,
    );
    // ArticleDetail should remain intact
    expect(result!.code).toContain(`const ArticleDetail = createLoader`);
    expect(result!.code).toContain(
      `ArticleDetail.$$id = "hash2#ArticleDetail";`,
    );
  });
});
