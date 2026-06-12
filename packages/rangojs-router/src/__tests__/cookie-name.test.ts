import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATE_COOKIE_PREFIX,
  decodeStateValue,
  encodeStateValue,
  serializeStateCookie,
  stateCookieAttributes,
} from "../browser/cookie-name.js";

describe("cookie-name", () => {
  it("uses rango-state as the default prefix", () => {
    expect(DEFAULT_STATE_COOKIE_PREFIX).toBe("rango-state");
  });

  describe("encodeStateValue", () => {
    it("keeps a plain version and raw timestamp around a literal colon", () => {
      expect(encodeStateValue("v1", 1234)).toBe("v1:1234");
    });

    it("percent-encodes only the version, leaving the colon separator raw", () => {
      // A version containing a colon must not introduce a second separator.
      expect(encodeStateValue("a:b", 5)).toBe("a%3Ab:5");
    });
  });

  describe("decodeStateValue", () => {
    it("round-trips an encoded value", () => {
      const encoded = encodeStateValue("a:b", 99);
      expect(decodeStateValue(encoded)).toEqual({
        version: "a:b",
        timestamp: 99,
      });
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
