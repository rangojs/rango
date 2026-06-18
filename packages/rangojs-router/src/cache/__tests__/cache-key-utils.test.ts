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

  // A4: the router owns NO blanket `__` URL query param, so a `__`-prefixed
  // consumer param must NOT be silently dropped (that collapsed `__variant=a`
  // and `__variant=b` onto one cache slot). Only the exact reserved `__no_cache`
  // (the handler bypass flag) is filtered.
  it("keeps consumer __* params (no blanket __ filter)", () => {
    const params = new URLSearchParams("q=test&__internal=1");
    expect(sortedSearchString(params)).toBe("__internal=1&q=test");
  });

  it("distinguishes consumer __ params with different values (A4 collision fix)", () => {
    const a = sortedSearchString(new URLSearchParams("__variant=a"));
    const b = sortedSearchString(new URLSearchParams("__variant=b"));
    expect(a).toBe("__variant=a");
    expect(b).toBe("__variant=b");
    expect(a).not.toBe(b);
  });

  it("still filters the reserved __no_cache bypass param", () => {
    const params = new URLSearchParams("page=1&__no_cache=1");
    expect(sortedSearchString(params)).toBe("page=1");
  });

  it("returns empty string when only reserved internal params exist", () => {
    const params = new URLSearchParams("_rsc_partial=1&__no_cache=1");
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
