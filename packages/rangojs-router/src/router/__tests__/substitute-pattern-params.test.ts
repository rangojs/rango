import { describe, it, expect } from "vitest";
import { substitutePatternParams } from "../substitute-pattern-params.js";

// useHref() and relative useRouter().push fill an include() mount (the
// include's URL pattern, as useMount() returns it) with
// substitutePatternParams(mount, params, mount).
const fill = (mount: string, params: Record<string, string | undefined>) =>
  substitutePatternParams(mount, params, mount);

describe("substitutePatternParams on an include() mount", () => {
  it("returns a static mount unchanged", () => {
    expect(fill("/shop", { id: "1" })).toBe("/shop");
    expect(fill("/shop/", {})).toBe("/shop/");
    expect(fill("/", {})).toBe("/");
  });

  it("fills every mount param from the current params", () => {
    expect(
      fill("/:accountId/:projectId", {
        accountId: "acme",
        projectId: "web",
        issueId: "7",
      }),
    ).toBe("/acme/web");
  });

  it("encodes values and strips constraints", () => {
    expect(fill("/:locale(en|de)/t/:team", { locale: "de", team: "a b" })).toBe(
      "/de/t/a%20b",
    );
  });

  it("omits an absent optional mount param", () => {
    expect(fill("/:locale?/shop", {})).toBe("/shop");
    expect(fill("/:locale?", {})).toBe("/");
  });

  it("throws Missing param for an absent required mount param", () => {
    expect(() => fill("/:accountId/:projectId", { accountId: "acme" })).toThrow(
      'Missing param "projectId" for route "/:accountId/:projectId"',
    );
  });
});
