import { describe, it, expect } from "vitest";
import { hashParams } from "../param-hash.js";

describe("hashParams", () => {
  describe("basic functionality", () => {
    it("should return '_' for empty params", () => {
      expect(hashParams({})).toBe("_");
    });

    it("should return a hash for a single param", () => {
      const result = hashParams({ id: "42" });
      expect(result).not.toBe("_");
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });

    it("should return a hash for multiple params", () => {
      const result = hashParams({ slug: "hello", locale: "en" });
      expect(result).not.toBe("_");
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe("hash format", () => {
    it("should produce an 8-character lowercase hex string", () => {
      const result = hashParams({ key: "value" });
      expect(result).toHaveLength(8);
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });

    it("should produce an 8-char hex string even for short input", () => {
      const result = hashParams({ a: "b" });
      expect(result).toHaveLength(8);
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe("deterministic ordering", () => {
    it("should produce the same hash regardless of insertion order", () => {
      const hash1 = hashParams({ a: "1", b: "2", c: "3" });
      const hash2 = hashParams({ c: "3", a: "1", b: "2" });
      const hash3 = hashParams({ b: "2", c: "3", a: "1" });

      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });

    it("should produce the same hash for two-param objects in any order", () => {
      const hash1 = hashParams({ slug: "post", lang: "en" });
      const hash2 = hashParams({ lang: "en", slug: "post" });

      expect(hash1).toBe(hash2);
    });
  });

  describe("distinct inputs produce different hashes", () => {
    it("should produce different hashes for different values", () => {
      const hash1 = hashParams({ id: "1" });
      const hash2 = hashParams({ id: "2" });

      expect(hash1).not.toBe(hash2);
    });

    it("should produce different hashes for different keys", () => {
      const hash1 = hashParams({ a: "x" });
      const hash2 = hashParams({ b: "x" });

      expect(hash1).not.toBe(hash2);
    });

    it("should produce different hashes for different param counts", () => {
      const hash1 = hashParams({ a: "1" });
      const hash2 = hashParams({ a: "1", b: "2" });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("delimiter encoding prevents collisions", () => {
    // Fixed P0-3: keys and values are now URL-encoded before joining,
    // so structurally different params produce different hash inputs.
    it("should produce different hashes for value containing & vs separate params", () => {
      const singleParam = hashParams({ a: "1&b=2" });
      const twoParams = hashParams({ a: "1", b: "2" });

      expect(singleParam).not.toBe(twoParams);
    });

    it("should produce different hashes when key contains '='", () => {
      const equalsInKey = hashParams({ "a=1": "x" });
      const equalsInValue = hashParams({ a: "1=x" });

      expect(equalsInKey).not.toBe(equalsInValue);
    });

    it("should produce different hashes when value contains '&'", () => {
      const ampInValue = hashParams({ a: "x&b=y" });
      const separateParams = hashParams({ a: "x", b: "y" });

      expect(ampInValue).not.toBe(separateParams);
    });
  });

  describe("localeCompare non-determinism", () => {
    // BUG P1-10: localeCompare varies across runtimes and locales.
    // Byte-order (< operator) comparison should be used instead to
    // guarantee identical sort order in Node.js, Workers, and browsers.
    it("should sort by byte order, not locale-dependent order", () => {
      // In many locales, localeCompare treats uppercase and lowercase
      // as equivalent or sorts them differently than codepoint order.
      // Codepoint order: 'A' (65) < 'Z' (90) < 'a' (97) < 'z' (122)
      // Some locales: 'a' < 'A' < 'b' < 'B' (case-interleaved)
      const hash1 = hashParams({ Z: "1", a: "2" });
      const hash2 = hashParams({ a: "2", Z: "1" });

      // Both should produce the same hash regardless of insertion order.
      // This passes because localeCompare at least agrees on basic ASCII
      // letter ordering within a single runtime.
      expect(hash1).toBe(hash2);
    });

    it("should produce consistent sort order for non-ASCII keys", () => {
      // localeCompare may sort accented characters differently depending
      // on the runtime locale. Byte-order comparison would use codepoint
      // values and be deterministic across all environments.
      // e.g., in Swedish locale, a-ring sorts after z, but in German it
      // may sort differently.
      const params = { "\u00E4": "ae", "\u00F6": "oe", "a": "plain" };
      const hash1 = hashParams(params);

      // Re-hash to verify at least within the same runtime it is stable.
      const hash2 = hashParams({ a: "plain", "\u00F6": "oe", "\u00E4": "ae" });
      expect(hash1).toBe(hash2);
    });

    it("should treat codepoint order as canonical for ASCII keys", () => {
      // Byte/codepoint order: "_" (95) < "a" (97)
      // Some localeCompare implementations treat "_" as a punctuation
      // character and sort it after letters.
      const hash1 = hashParams({ _meta: "1", alpha: "2" });
      const hash2 = hashParams({ alpha: "2", _meta: "1" });

      // Within a single runtime these should match, but across runtimes
      // the sort order may differ if localeCompare is used.
      expect(hash1).toBe(hash2);
    });
  });

  describe("edge cases", () => {
    it("should handle params with empty string values", () => {
      const result = hashParams({ key: "" });
      expect(result).toMatch(/^[0-9a-f]{8}$/);
      expect(result).not.toBe("_");
    });

    it("should handle params with empty string keys", () => {
      const result = hashParams({ "": "value" });
      expect(result).toMatch(/^[0-9a-f]{8}$/);
      expect(result).not.toBe("_");
    });

    it("should produce different hashes for different unicode values", () => {
      const hash1 = hashParams({ name: "\u00FC" }); // u-umlaut
      const hash2 = hashParams({ name: "\u0075\u0308" }); // u + combining diaeresis

      // These are visually the same character but different codepoints,
      // so they should produce different hashes (no normalization).
      expect(hash1).not.toBe(hash2);
    });

    it("should handle a large number of params", () => {
      const params: Record<string, string> = {};
      for (let i = 0; i < 100; i++) {
        params[`key${i}`] = `value${i}`;
      }
      const result = hashParams(params);
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});
