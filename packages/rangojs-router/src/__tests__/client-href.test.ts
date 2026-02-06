import { describe, it, expect, expectTypeOf } from "vitest";
import { href, type PatternToPath, type ValidPaths } from "../href-client.js";

describe("href()", () => {
  describe("without mount", () => {
    it("returns path unchanged", () => {
      expect(href("/foo")).toBe("/foo");
    });

    it("handles root path", () => {
      expect(href("/")).toBe("/");
    });

    it("handles nested paths", () => {
      expect(href("/blog/my-post")).toBe("/blog/my-post");
    });

    it("handles paths with query strings", () => {
      expect(href("/search?q=test")).toBe("/search?q=test");
    });

    it("handles paths with hash fragments", () => {
      expect(href("/about#contact")).toBe("/about#contact");
    });

    it("handles paths with query and hash", () => {
      expect(href("/page?a=1#top")).toBe("/page?a=1#top");
    });
  });

  describe("with mount", () => {
    it("prepends mount to path", () => {
      expect(href("/foo", "/articles")).toBe("/articles/foo");
    });

    it("prepends mount to root path", () => {
      expect(href("/", "/articles")).toBe("/articles/");
    });

    it("handles nested mount", () => {
      expect(href("/detail", "/articles/comments")).toBe(
        "/articles/comments/detail",
      );
    });

    it("treats root mount as no mount", () => {
      expect(href("/foo", "/")).toBe("/foo");
    });

    it("handles undefined mount", () => {
      expect(href("/foo", undefined)).toBe("/foo");
    });

    it("handles empty string mount", () => {
      expect(href("/foo", "")).toBe("/foo");
    });
  });

  describe("PatternToPath types", () => {
    it("static path", () => {
      expectTypeOf<PatternToPath<"/about">>().toEqualTypeOf<"/about">();
    });

    it("dynamic param", () => {
      expectTypeOf<PatternToPath<"/blog/:slug">>().toEqualTypeOf<
        `/blog/${string}`
      >();
    });

    it("optional param at end", () => {
      expectTypeOf<PatternToPath<"/settings/:tab?">>().toEqualTypeOf<
        "/settings/" | `/settings/${string}`
      >();
    });

    it("constrained param", () => {
      expectTypeOf<
        PatternToPath<"/checkout/:step(shipping|payment)">
      >().toEqualTypeOf<"/checkout/shipping" | "/checkout/payment">();
    });

    it("multiple dynamic params", () => {
      expectTypeOf<PatternToPath<"/user/:id/post/:slug">>().toEqualTypeOf<
        `/user/${string}/post/${string}`
      >();
    });

    it("root path stays root", () => {
      expectTypeOf<PatternToPath<"/">>().toEqualTypeOf<"/">();
    });
  });

  describe("ValidPaths fallback", () => {
    // When no routes are registered, ValidPaths falls back to `/${string}`
    // This is tested implicitly by the fact that href() accepts any path starting with /
    it("accepts any path when no routes registered", () => {
      // href() is callable with any /-prefixed string
      const result: string = href("/anything/at/all");
      expect(result).toBe("/anything/at/all");
    });
  });
});
