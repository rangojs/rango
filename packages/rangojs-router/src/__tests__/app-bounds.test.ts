import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOtherAppHref, setAppBounds } from "../browser/app-bounds";

describe("isOtherAppHref", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost",
        href: "http://localhost/app-a/page",
      },
    });
  });

  afterEach(() => {
    setAppBounds(undefined);
    vi.unstubAllGlobals();
  });

  it("is false for every href when the app owns every path", () => {
    expect(isOtherAppHref("/app-b")).toBe(false);
    expect(isOtherAppHref("http://localhost/anything")).toBe(false);
  });

  it("a path-mounted app owns its prefix and nothing else", () => {
    setAppBounds([[["/app-a", true]]]);
    expect(isOtherAppHref("/app-a")).toBe(false);
    expect(isOtherAppHref("/app-a/page?x=1#top")).toBe(false);
    expect(isOtherAppHref("page")).toBe(false);
    expect(isOtherAppHref("/app-b")).toBe(true);
    expect(isOtherAppHref("/")).toBe(true);
    // A prefix covers whole segments only, as the host router matches it.
    expect(isOtherAppHref("/app-ab")).toBe(true);
    // Paths are case-sensitive, as the host router matches them.
    expect(isOtherAppHref("/APP-A")).toBe(true);
    expect(isOtherAppHref("../app-b/x")).toBe(true);
  });

  it("the catch-all app owns every path but the mounts named before it", () => {
    setAppBounds([
      [
        ["/app-a", false],
        ["/app-b", false],
        ["", true],
      ],
    ]);
    expect(isOtherAppHref("/about")).toBe(false);
    expect(isOtherAppHref("/")).toBe(false);
    expect(isOtherAppHref("/app-a")).toBe(true);
    expect(isOtherAppHref("/app-b/page")).toBe(true);
    expect(isOtherAppHref("/app-bb")).toBe(false);
  });

  it("leaves other origins to the external-link rules", () => {
    setAppBounds([[["/app-a", true]]]);
    expect(isOtherAppHref("https://example.com/app-b")).toBe(false);
  });

  it("is false for an href that does not parse, never a throw", () => {
    setAppBounds([[["/app-a", true]]]);
    // Link treats a malformed absolute URL as internal (isExternalUrl), so
    // its click handler reaches this check with it.
    expect(isOtherAppHref("http://[::1")).toBe(false);
  });

  it("a path is the app's only when every host router on its way says so", () => {
    setAppBounds([
      [["/app-a", true]],
      [
        ["/app-a/admin", false],
        ["", true],
      ],
    ]);
    expect(isOtherAppHref("/app-a/page")).toBe(false);
    expect(isOtherAppHref("/app-a/admin/users")).toBe(true);
    expect(isOtherAppHref("/elsewhere")).toBe(true);
  });
});
