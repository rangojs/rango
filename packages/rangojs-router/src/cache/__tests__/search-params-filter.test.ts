import { describe, it, expect } from "vitest";
import {
  compileSearchParamsFilter,
  TRACKING_SEARCH_PARAMS,
} from "../search-params-filter.js";

describe("compileSearchParamsFilter", () => {
  it("returns undefined for the default ('all' / no config) so the unfiltered key path stays byte-stable", () => {
    expect(compileSearchParamsFilter(undefined)).toBeUndefined();
    expect(compileSearchParamsFilter("all")).toBeUndefined();
  });

  it("'none' rejects every param", () => {
    const filter = compileSearchParamsFilter("none")!;
    expect(filter("q")).toBe(false);
    expect(filter("page")).toBe(false);
    expect(filter("")).toBe(false);
  });

  it("include allowlists exact names", () => {
    const filter = compileSearchParamsFilter({ include: ["q", "page"] })!;
    expect(filter("q")).toBe(true);
    expect(filter("page")).toBe(true);
    expect(filter("utm_source")).toBe(false);
    expect(filter("Q")).toBe(false);
  });

  it("exclude denylists exact names", () => {
    const filter = compileSearchParamsFilter({ exclude: ["fbclid"] })!;
    expect(filter("fbclid")).toBe(false);
    expect(filter("q")).toBe(true);
  });

  it("supports * suffix wildcards", () => {
    const include = compileSearchParamsFilter({ include: ["utm_*"] })!;
    expect(include("utm_source")).toBe(true);
    expect(include("utm_")).toBe(true);
    expect(include("utm")).toBe(false);
    expect(include("q")).toBe(false);

    const exclude = compileSearchParamsFilter({ exclude: ["utm_*"] })!;
    expect(exclude("utm_source")).toBe(false);
    expect(exclude("q")).toBe(true);
  });

  it("treats a non-trailing * literally (no RegExp semantics)", () => {
    const filter = compileSearchParamsFilter({ include: ["a*b"] })!;
    expect(filter("a*b")).toBe(true);
    expect(filter("axb")).toBe(false);
  });

  it("a bare '*' pattern matches everything (include:['*'] ~ all, exclude:['*'] ~ none)", () => {
    const all = compileSearchParamsFilter({ include: ["*"] })!;
    expect(all("anything")).toBe(true);
    const none = compileSearchParamsFilter({ exclude: ["*"] })!;
    expect(none("anything")).toBe(false);
  });

  it("TRACKING_SEARCH_PARAMS covers the common click-id/tracking params via exclude", () => {
    const filter = compileSearchParamsFilter({
      exclude: TRACKING_SEARCH_PARAMS,
    })!;
    for (const name of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "gclid",
      "fbclid",
      "msclkid",
      "ttclid",
      "mc_eid",
    ]) {
      expect(filter(name), name).toBe(false);
    }
    expect(filter("q")).toBe(true);
    expect(filter("page")).toBe(true);
  });
});
