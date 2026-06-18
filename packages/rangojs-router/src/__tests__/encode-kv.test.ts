import { describe, it, expect } from "vitest";
import { encodeKV } from "../encode-kv.js";

describe("encodeKV", () => {
  it("returns empty string for no pairs", () => {
    expect(encodeKV([])).toBe("");
    expect(encodeKV([], { sort: true })).toBe("");
  });

  it("preserves insertion order when sort is off (default)", () => {
    expect(
      encodeKV([
        ["z", "1"],
        ["a", "2"],
        ["m", "3"],
      ]),
    ).toBe("z=1&a=2&m=3");
  });

  it("sorts by key in byte order when sort is on", () => {
    expect(
      encodeKV(
        [
          ["z", "1"],
          ["a", "2"],
          ["m", "3"],
        ],
        { sort: true },
      ),
    ).toBe("a=2&m=3&z=1");
  });

  it("sorts by codepoint (byte) order, not locale order", () => {
    // Codepoint order: 'A' (65) < 'a' (97). A locale-aware sort might interleave.
    expect(
      encodeKV(
        [
          ["a", "1"],
          ["A", "2"],
        ],
        { sort: true },
      ),
    ).toBe("A=2&a=1");
  });

  it("encodes special characters in keys and values", () => {
    expect(encodeKV([["a b", "c&d"]])).toBe("a%20b=c%26d");
    expect(encodeKV([["x", "1=2"]])).toBe("x=1%3D2");
  });

  it("preserves duplicate keys (does not dedupe)", () => {
    expect(
      encodeKV([
        ["a", "1"],
        ["a", "2"],
      ]),
    ).toBe("a=1&a=2");
  });

  it("encodes exactly what it is given (no value coercion or skipping)", () => {
    // encodeKV never inspects values: an empty-string value is encoded, not
    // skipped. Callers that skip null/undefined pre-filter before calling.
    expect(encodeKV([["k", ""]])).toBe("k=");
  });

  it("accepts any iterable of pairs (e.g. URLSearchParams entries)", () => {
    const sp = new URLSearchParams("b=2&a=1");
    expect(encodeKV(sp, { sort: true })).toBe("a=1&b=2");
  });

  // The encode rule must be byte-identical to each call site's prior inline
  // implementation, so structurally different pair sets never collide.
  it("disambiguates a value containing '&' from two separate pairs", () => {
    const single = encodeKV([["a", "1&b=2"]]);
    const two = encodeKV([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(single).not.toBe(two);
  });
});
