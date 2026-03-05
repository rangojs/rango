import { describe, it, expect } from "vitest";
import { sortedSearchString, sortedRouteParams } from "../cache-key-utils.js";

describe("sortedSearchString", () => {
  it("returns empty string for no params", () => {
    expect(sortedSearchString(new URLSearchParams())).toBe("");
  });

  it("sorts params alphabetically", () => {
    const params = new URLSearchParams("z=1&a=2&m=3");
    expect(sortedSearchString(params)).toBe("a=2&m=3&z=1");
  });

  it("excludes _rsc* internal params", () => {
    const params = new URLSearchParams("page=1&_rsc_action=foo&_rsc_partial=1");
    expect(sortedSearchString(params)).toBe("page=1");
  });

  it("excludes __* internal params", () => {
    const params = new URLSearchParams("q=test&__internal=1");
    expect(sortedSearchString(params)).toBe("q=test");
  });

  it("returns empty string when only internal params exist", () => {
    const params = new URLSearchParams("_rsc_partial=1&__debug=true");
    expect(sortedSearchString(params)).toBe("");
  });

  it("encodes special characters", () => {
    const params = new URLSearchParams();
    params.set("q", "hello world");
    params.set("tag", "a&b");
    expect(sortedSearchString(params)).toBe("q=hello%20world&tag=a%26b");
  });

  it("handles duplicate keys (preserves all values)", () => {
    const params = new URLSearchParams("a=1&a=2");
    expect(sortedSearchString(params)).toBe("a=1&a=2");
  });
});

describe("sortedRouteParams", () => {
  it("returns empty string for undefined", () => {
    expect(sortedRouteParams(undefined)).toBe("");
  });

  it("returns empty string for empty object", () => {
    expect(sortedRouteParams({})).toBe("");
  });

  it("sorts params alphabetically", () => {
    expect(sortedRouteParams({ z: "1", a: "2", m: "3" })).toBe("a=2&m=3&z=1");
  });

  it("encodes special characters in keys and values", () => {
    expect(sortedRouteParams({ "a b": "c&d" })).toBe("a%20b=c%26d");
  });

  it("handles single param", () => {
    expect(sortedRouteParams({ id: "42" })).toBe("id=42");
  });
});
