import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STATE_COOKIE_PREFIX,
  bumpStateWrite,
  freshReadsCookieName,
  decodeStateValue,
  encodeStateValue,
  mintStateValue,
  serializeStateCookie,
  stateCookieAttributes,
  stateEpoch,
} from "../browser/cookie-name.js";

describe("cookie-name", () => {
  it("uses rango-state as the default prefix", () => {
    expect(DEFAULT_STATE_COOKIE_PREFIX).toBe("rango-state");
  });

  // One fresh-reads cookie per state-cookie prefix, shared by every router on
  // the host that uses the prefix (the prefix never contains `_`).
  it("names the fresh-reads cookie after the state cookie's prefix", () => {
    expect(freshReadsCookieName("rango-state_router_0")).toBe(
      "rango-state-fresh",
    );
    expect(freshReadsCookieName("rango-state_admin")).toBe("rango-state-fresh");
    expect(freshReadsCookieName("shop_router_1")).toBe("shop-fresh");
    expect(freshReadsCookieName("rango-state")).toBe("rango-state-fresh");
  });

  describe("encodeStateValue", () => {
    it("keeps a plain version and raw timestamp around a literal colon", () => {
      expect(encodeStateValue("v1", 1234)).toBe("v1:1234");
    });

    it("percent-encodes only the version, leaving the colon separator raw", () => {
      // A version containing a colon must not introduce a second separator.
      expect(encodeStateValue("a:b", 5)).toBe("a%3Ab:5");
    });

    it("adds the write part as a third segment, and leaves it out while 0", () => {
      expect(encodeStateValue("v1", 1234, 77)).toBe("v1:1234:77");
      expect(encodeStateValue("v1", 1234, 0)).toBe("v1:1234");
      expect(encodeStateValue("a:b", 5, 6)).toBe("a%3Ab:5:6");
    });
  });

  describe("decodeStateValue", () => {
    it("round-trips an encoded value", () => {
      const encoded = encodeStateValue("a:b", 99);
      expect(decodeStateValue(encoded)).toEqual({
        version: "a:b",
        timestamp: 99,
        write: 0,
      });
      expect(decodeStateValue(encodeStateValue("a:b", 99, 7))).toEqual({
        version: "a:b",
        timestamp: 99,
        write: 7,
      });
    });

    it("parses a two-part value (an open tab from before the write part) with write 0", () => {
      expect(decodeStateValue("v1:1234")).toEqual({
        version: "v1",
        timestamp: 1234,
        write: 0,
      });
    });

    it("returns null for a non-numeric or empty write part, or a fourth part", () => {
      expect(decodeStateValue("v1:1:abc")).toBeNull();
      expect(decodeStateValue("v1:1:")).toBeNull();
      expect(decodeStateValue("v1:1:2:3")).toBeNull();
    });

    it("returns null for a value with no colon", () => {
      expect(decodeStateValue("nope")).toBeNull();
    });

    it("returns null for an empty version (leading colon)", () => {
      expect(decodeStateValue(":123")).toBeNull();
    });

    it("returns null for a non-numeric timestamp", () => {
      expect(decodeStateValue("v1:abc")).toBeNull();
    });

    it("returns null (does not throw) on a malformed percent-escape", () => {
      // decodeURIComponent("%") throws URIError; the codec must absorb it.
      expect(decodeStateValue("%:1")).toBeNull();
      expect(decodeStateValue("%E0%A4%A:5")).toBeNull();
    });
  });

  describe("stateEpoch", () => {
    // The part every in-memory comparison on the client reads: a write-only
    // change keeps it, a rotation or a deploy changes it.
    it("is the {version}:{timestamp} part, the same for a value and its write bumps", () => {
      expect(stateEpoch("v1:1234")).toBe("v1:1234");
      expect(stateEpoch("v1:1234:99")).toBe("v1:1234");
      expect(stateEpoch("v1:1234:100")).toBe(stateEpoch("v1:1234"));
      expect(stateEpoch("v1:1235")).not.toBe(stateEpoch("v1:1234:99"));
      expect(stateEpoch("v2:1234:99")).not.toBe(stateEpoch("v1:1234:99"));
    });

    it("cuts at the write separator even for a version holding a colon", () => {
      expect(stateEpoch(encodeStateValue("a:b", 5, 6))).toBe("a%3Ab:5");
    });

    it("returns a value without a colon as it is", () => {
      expect(stateEpoch("0")).toBe("0");
    });
  });

  describe("mintStateValue and bumpStateWrite", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("mint: a newer timestamp and no write part", () => {
      vi.useFakeTimers({ now: 1000 });
      expect(mintStateValue("v1", "v1:5000:9000")).toBe("v1:5001");
      expect(mintStateValue("v1", null)).toBe("v1:1000");
    });

    it("bump: the timestamp kept, the write part strictly greater", () => {
      vi.useFakeTimers({ now: 1000 });
      expect(bumpStateWrite("v1", "v1:500")).toBe("v1:500:1000");
      // A previous write ahead of the clock (or in the same ms) still moves.
      expect(bumpStateWrite("v1", "v1:500:1000")).toBe("v1:500:1001");
      expect(bumpStateWrite("v1", "v1:500:4000")).toBe("v1:500:4001");
      expect(stateEpoch(bumpStateWrite("v1", "v1:500:4000")!)).toBe("v1:500");
    });

    it("bump: null without a usable previous value", () => {
      expect(bumpStateWrite("v1", null)).toBeNull();
      expect(bumpStateWrite("v1", "garbage")).toBeNull();
    });
  });

  describe("stateCookieAttributes", () => {
    it("omits Secure on http", () => {
      expect(stateCookieAttributes(false)).toBe("; Path=/; SameSite=Lax");
    });

    it("adds Secure on https", () => {
      expect(stateCookieAttributes(true)).toBe(
        "; Path=/; SameSite=Lax; Secure",
      );
    });

    it("never sets Max-Age, Expires, or HttpOnly (session, client-readable)", () => {
      const attrs = stateCookieAttributes(true);
      expect(attrs).not.toMatch(/Max-Age/i);
      expect(attrs).not.toMatch(/Expires/i);
      expect(attrs).not.toMatch(/HttpOnly/i);
    });
  });

  describe("serializeStateCookie", () => {
    it("joins name=value with the attribute string", () => {
      expect(serializeStateCookie("rango-state_router_0", "v1:5", false)).toBe(
        "rango-state_router_0=v1:5; Path=/; SameSite=Lax",
      );
    });
  });
});
