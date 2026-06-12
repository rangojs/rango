import { describe, expect, it } from "vitest";
import { resolveStateCookieName } from "../router/state-cookie-name.js";

describe("resolveStateCookieName", () => {
  it("uses the default prefix when none is given", () => {
    expect(resolveStateCookieName(undefined, "router_0")).toBe(
      "rango-state_router_0",
    );
  });

  it("uses a provided prefix verbatim when already token-safe", () => {
    expect(resolveStateCookieName("my-app", "router_0")).toBe(
      "my-app_router_0",
    );
  });

  it("strips characters illegal in a cookie name, including underscores in the prefix", () => {
    // `_` is dropped from the prefix so it cannot be confused with the separator.
    expect(resolveStateCookieName("my_app!", "r1")).toBe("myapp_r1");
  });

  it("falls back to the default when the prefix sanitizes to empty", () => {
    expect(resolveStateCookieName("___", "r1")).toBe("rango-state_r1");
    expect(resolveStateCookieName("!@#", "r1")).toBe("rango-state_r1");
  });

  it("keeps underscores in the routerId (the counter fallback is router_N)", () => {
    expect(resolveStateCookieName("p", "router_12")).toBe("p_router_12");
  });

  it("sanitizes the routerId too (illegal chars dropped)", () => {
    expect(resolveStateCookieName("p", "a:b")).toBe("p_ab");
  });

  it("is injective: the first underscore is always the prefix/routerId boundary", () => {
    // Prefix `rango-state_router` would collide with the default under a naive
    // join; dropping `_` from the prefix charset keeps the names distinct.
    expect(resolveStateCookieName("rango-state", "router_0")).toBe(
      "rango-state_router_0",
    );
    expect(resolveStateCookieName("rango-state_router", "0")).toBe(
      "rango-staterouter_0",
    );
    expect(resolveStateCookieName("rango-state_router", "0")).not.toBe(
      resolveStateCookieName("rango-state", "router_0"),
    );
  });
});
