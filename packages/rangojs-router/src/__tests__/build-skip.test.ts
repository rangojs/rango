import { describe, it, expect } from "vitest";
import { Skip, isSkip } from "../errors.js";

describe("Skip", () => {
  it("should be an instance of Error", () => {
    const skip = new Skip("test");
    expect(skip).toBeInstanceOf(Error);
    expect(skip).toBeInstanceOf(Skip);
  });

  it("should have name 'Skip'", () => {
    const skip = new Skip("reason");
    expect(skip.name).toBe("Skip");
  });

  it("should have a default message", () => {
    const skip = new Skip();
    expect(skip.message).toBe("Entry skipped");
  });

  it("should support custom message", () => {
    const skip = new Skip("Article is a draft");
    expect(skip.message).toBe("Article is a draft");
  });

  it("should support cause option", () => {
    const cause = new Error("underlying");
    const skip = new Skip("skipped", { cause });
    expect(skip.cause).toBe(cause);
  });

  it("should have a stack trace", () => {
    const skip = new Skip("test");
    expect(skip.stack).toBeDefined();
    expect(skip.stack).toContain("Skip");
  });

  it("should preserve prototype chain", () => {
    const skip = new Skip();
    expect(Object.getPrototypeOf(skip)).toBe(Skip.prototype);
  });
});

describe("isSkip", () => {
  it("should return true for Skip instances", () => {
    expect(isSkip(new Skip())).toBe(true);
    expect(isSkip(new Skip("reason"))).toBe(true);
  });

  it("should return false for regular errors", () => {
    expect(isSkip(new Error("test"))).toBe(false);
    expect(isSkip(new TypeError("test"))).toBe(false);
  });

  it("should return false for non-error values", () => {
    expect(isSkip(null)).toBe(false);
    expect(isSkip(undefined)).toBe(false);
    expect(isSkip("string")).toBe(false);
    expect(isSkip(42)).toBe(false);
    expect(isSkip({})).toBe(false);
  });
});
