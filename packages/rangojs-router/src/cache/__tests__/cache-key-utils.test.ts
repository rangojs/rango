import { describe, it, expect } from "vitest";
import {
  sortedSearchString,
  sortedRouteParams,
  cacheKeyBase,
} from "../cache-key-utils.js";
import { compileSearchParamsFilter } from "../search-params-filter.js";

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

describe("sortedSearchString with cache.searchParams filter", () => {
  it("drops excluded params from the key", () => {
    const filter = compileSearchParamsFilter({ exclude: ["utm_*", "fbclid"] });
    const params = new URLSearchParams("utm_source=tw&page=2&fbclid=abc&q=x");
    expect(sortedSearchString(params, filter)).toBe("page=2&q=x");
  });

  it("include mode keeps only the allowlisted params", () => {
    const filter = compileSearchParamsFilter({ include: ["q", "page"] });
    const params = new URLSearchParams("utm_source=tw&page=2&q=x&sort=asc");
    expect(sortedSearchString(params, filter)).toBe("page=2&q=x");
  });

  it("'none' produces an empty search key regardless of params", () => {
    const filter = compileSearchParamsFilter("none");
    const params = new URLSearchParams("a=1&b=2");
    expect(sortedSearchString(params, filter)).toBe("");
  });

  it("cannot re-include reserved router params (reserved exclusion applies first)", () => {
    const filter = compileSearchParamsFilter({
      include: ["__no_cache", "_rsc_partial", "q"],
    });
    const params = new URLSearchParams("__no_cache=1&_rsc_partial=1&q=x");
    expect(sortedSearchString(params, filter)).toBe("q=x");
  });

  it("filtering happens before the sort (surviving params stay order-insensitive)", () => {
    const filter = compileSearchParamsFilter({ exclude: ["utm_*"] });
    const a = sortedSearchString(
      new URLSearchParams("z=1&utm_source=x&a=2"),
      filter,
    );
    const b = sortedSearchString(
      new URLSearchParams("a=2&z=1&utm_medium=y"),
      filter,
    );
    expect(a).toBe("a=2&z=1");
    expect(b).toBe(a);
  });

  it("a URL with no filtered params produces the same key as the unfiltered path (byte-stability)", () => {
    const filter = compileSearchParamsFilter({ exclude: ["utm_*"] });
    const params = new URLSearchParams("page=2&q=x");
    expect(sortedSearchString(params, filter)).toBe(sortedSearchString(params));
  });
});

describe("cacheKeyBase with cache.searchParams filter", () => {
  it("collapses excluded-param variants onto one key", () => {
    const filter = compileSearchParamsFilter({ exclude: ["utm_*"] });
    const a = cacheKeyBase(
      "example.com",
      "/products",
      new URLSearchParams("utm_source=tw"),
      undefined,
      filter,
    );
    const b = cacheKeyBase(
      "example.com",
      "/products",
      new URLSearchParams("utm_source=ig"),
      undefined,
      filter,
    );
    expect(a).toBe("example.com/products");
    expect(b).toBe(a);
  });

  it("without a filter, variants stay distinct (default behavior unchanged)", () => {
    const a = cacheKeyBase(
      "example.com",
      "/products",
      new URLSearchParams("utm_source=tw"),
    );
    const b = cacheKeyBase(
      "example.com",
      "/products",
      new URLSearchParams("utm_source=ig"),
    );
    expect(a).not.toBe(b);
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
