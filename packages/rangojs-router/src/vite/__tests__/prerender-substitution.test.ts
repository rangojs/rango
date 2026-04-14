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

  it("strips optional param when not in params", () => {
    expect(
      substituteRouteParams("/category/:name/:page?", { name: "shoes" }),
    ).toBe("/category/shoes");
  });

  it("includes optional param when provided", () => {
    expect(
      substituteRouteParams("/category/:name/:page?", {
        name: "shoes",
        page: "2",
      }),
    ).toBe("/category/shoes/2");
  });

  it("strips optional constrained param when not in params", () => {
    expect(substituteRouteParams("/:locale(en|gb)?/blog", {})).toBe("/blog");
  });

  it("preserves trailing slash on non-optional patterns", () => {
    expect(substituteRouteParams("/blog/", {})).toBe("/blog/");
  });

  it("preserves trailing slash when optional param is omitted from slash-terminated pattern", () => {
    expect(substituteRouteParams("/:locale(en|gb)?/blog/", {})).toBe("/blog/");
    expect(
      substituteRouteParams("/category/:name/:page?/", { name: "shoes" }),
    ).toBe("/category/shoes/");
  });

  // Regression: consecutive optional middle params must collapse into single
  // slashes when omitted, not produce "///id".
  describe("consecutive optional middle params", () => {
    it("omits all optionals, keeps required tail", () => {
      expect(
        substituteRouteParams("/:a?/:b?/:productId", { productId: "id" }),
      ).toBe("/id");
      expect(
        substituteRouteParams("/shop/:a?/:b?/:productId", {
          productId: "id",
        }),
      ).toBe("/shop/id");
      expect(substituteRouteParams("/:a?/:b?/:c?/end", {})).toBe("/end");
    });

    it("provides only the first optional", () => {
      expect(
        substituteRouteParams("/:a?/:b?/:productId", {
          a: "x",
          productId: "id",
        }),
      ).toBe("/x/id");
    });

    it("provides only the second optional", () => {
      expect(
        substituteRouteParams("/:a?/:b?/:productId", {
          b: "y",
          productId: "id",
        }),
      ).toBe("/y/id");
    });

    it("provides first and third optional (skips middle)", () => {
      expect(
        substituteRouteParams("/:a?/:b?/:c?/end", { a: "x", c: "z" }),
      ).toBe("/x/z/end");
    });

    it("provides all optionals", () => {
      expect(
        substituteRouteParams("/:a?/:b?/:productId", {
          a: "x",
          b: "y",
          productId: "id",
        }),
      ).toBe("/x/y/id");
    });

    it("omits all constrained optionals, keeps required tail", () => {
      expect(
        substituteRouteParams("/:locale(en|gb)?/:region(us|eu)?/:productId", {
          productId: "id",
        }),
      ).toBe("/id");
    });

    // Regression: the trie matcher fills unmatched optional params with "",
    // and getParams() implementations may pass that through unchanged.
    // Empty-string values for optionals must collapse, not leave empty slots.
    it("treats empty-string optionals as omitted (trie fill behaviour)", () => {
      expect(
        substituteRouteParams(
          "/:b1?/:b2?/:b3?/:b4?/:b5?/:b6?/:productId.html",
          {
            b1: "",
            b2: "",
            b3: "",
            b4: "",
            b5: "",
            b6: "",
            productId: "SB8046_NavyBlue",
          },
        ),
      ).toBe("/SB8046_NavyBlue.html");
    });

    it("empty-string mid optional collapses around a provided neighbour", () => {
      expect(
        substituteRouteParams("/:a?/:b?/:c?/end", {
          a: "",
          b: "mid",
          c: "",
        }),
      ).toBe("/mid/end");
    });

    // Empty-string required/wildcard substitution must still work — the
    // empty-optional carve-out above is deliberately narrow.
    it("substitutes empty string for required param", () => {
      expect(substituteRouteParams("/blog/:slug", { slug: "" })).toBe("/blog/");
    });

    it("substitutes empty string for wildcard param", () => {
      expect(substituteRouteParams("/api/*rest", { rest: "" })).toBe("/api/");
    });

    it("substitutes empty string for constrained required param", () => {
      // Matches prior behaviour — the empty-optional carve-out must not
      // collapse slashes around required placeholders.
      expect(
        substituteRouteParams("/:locale(en|gb)/blog", { locale: "" }),
      ).toBe("//blog");
    });
  });
});
