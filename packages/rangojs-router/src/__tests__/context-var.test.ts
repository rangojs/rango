import { describe, it, expect } from "vitest";
import { createVar, contextGet, contextSet } from "../context-var.js";

describe("contextVar", () => {
  describe("contextSet / contextGet with string keys", () => {
    it("sets and gets a string-keyed variable", () => {
      const vars: Record<string, any> = {};
      contextSet(vars, "foo", 42);
      expect(contextGet(vars, "foo")).toBe(42);
    });

    it("rejects __proto__ key", () => {
      const vars: Record<string, any> = {};
      expect(() => contextSet(vars, "__proto__", {})).toThrow(/reserved key/);
    });

    it("rejects constructor key", () => {
      const vars: Record<string, any> = {};
      expect(() => contextSet(vars, "constructor", {})).toThrow(/reserved key/);
    });

    it("rejects prototype key", () => {
      const vars: Record<string, any> = {};
      expect(() => contextSet(vars, "prototype", {})).toThrow(/reserved key/);
    });
  });

  describe("contextSet / contextGet with ContextVar tokens", () => {
    it("sets and gets a typed variable via token", () => {
      const vars: Record<string | symbol, any> = {};
      const token = createVar<number>();
      contextSet(vars, token, 99);
      expect(contextGet(vars, token)).toBe(99);
    });
  });
});
