import { describe, it, expect } from "vitest";
import {
  substituteRouteParams,
  encodePathParam,
} from "../utils/prerender-utils.js";

describe("substituteRouteParams", () => {
  it("substitutes simple dynamic param", () => {
    expect(substituteRouteParams("/blog/:slug", { slug: "hello" })).toBe(
      "/blog/hello",
    );
  });

  it("substitutes constrained required param", () => {
    expect(
      substituteRouteParams("/:locale(en|gb)/blog", { locale: "en" }),
    ).toBe("/en/blog");
  });

  it("substitutes constrained optional param", () => {
    expect(
      substituteRouteParams("/:locale(en|gb)?/blog", { locale: "gb" }),
    ).toBe("/gb/blog");
  });

  it("substitutes multiple constrained params", () => {
    expect(
      substituteRouteParams(
        "/:locale(en|gb)?/:step(shipping|payment)/checkout",
        { locale: "en", step: "shipping" },
      ),
    ).toBe("/en/shipping/checkout");
  });

  it("uses default encodeURIComponent encoder", () => {
    expect(
      substituteRouteParams("/:locale(en|gb)/blog/:slug", {
        locale: "en",
        slug: "hello world",
      }),
    ).toBe("/en/blog/hello%20world");
  });

  it("accepts custom encoder (encodePathParam)", () => {
    expect(
      substituteRouteParams("/files/*path", { path: "a/b/c" }, encodePathParam),
    ).toBe("/files/a/b/c");
  });

  it("handles wildcard param substitution", () => {
    expect(substituteRouteParams("/api/*rest", { rest: "users/123" })).toBe(
      "/api/users%2F123",
    );
  });
});
