import { describe, expect, it } from "vitest";
import {
  getCookie,
  handleCookieOverride,
  parseCookies,
} from "../cookie-handler.js";
import { InvalidHostnameError } from "../errors.js";
import type { HostOverrideConfig } from "../types.js";

function reqWithCookie(cookie: string): Request {
  return new Request("http://localhost/", { headers: { cookie } });
}

describe("cookie-handler parseCookies", () => {
  it("parses normal name=value pairs", () => {
    const cookies = parseCookies(reqWithCookie("a=1; b=2"));
    expect(cookies).toEqual({ a: "1", b: "2" });
  });

  it("url-decodes values", () => {
    const cookies = parseCookies(reqWithCookie("greeting=hello%20world"));
    expect(cookies.greeting).toBe("hello world");
  });

  it("returns {} when no cookie header", () => {
    const cookies = parseCookies(new Request("http://localhost/"));
    expect(cookies).toEqual({});
  });

  // Drift fix: bare-name cookie (no "=") must resolve to "" to match the
  // canonical parseCookiesFromHeader. The old host loop required rest.length>0
  // and dropped it.
  it("keeps a bare-name cookie as empty string", () => {
    const cookies = parseCookies(reqWithCookie("a=1; foo; b=2"));
    expect(cookies).toEqual({ a: "1", foo: "", b: "2" });
  });

  it("falls back to raw value on malformed percent-encoding", () => {
    const cookies = parseCookies(reqWithCookie("x=%"));
    expect(cookies.x).toBe("%");
  });
});

describe("cookie-handler getCookie", () => {
  it("returns a specific cookie value", () => {
    expect(getCookie(reqWithCookie("a=1; b=2"), "b")).toBe("2");
  });

  it("returns undefined for an absent cookie", () => {
    expect(getCookie(reqWithCookie("a=1"), "missing")).toBeUndefined();
  });
});

describe("cookie-handler handleCookieOverride hostname normalization", () => {
  const config: HostOverrideConfig = {
    cookieName: "host",
    // "**" matches any host so isHostAllowed passes for localhost.
    allowedHosts: ["**"],
  };

  // URL.hostname ASCII-lowercases the host, so a mixed-case cookie value must
  // be compared against (and returned as) its canonical lowercase form.
  it("accepts a mixed-case hostname and returns the canonical lowercase host", () => {
    const result = handleCookieOverride(
      reqWithCookie("host=Admin.Example.Com"),
      config,
      {} as any,
    );
    expect(result).toBe("admin.example.com");
  });

  it("still rejects a cookie value carrying a path", () => {
    expect(() =>
      handleCookieOverride(
        reqWithCookie("host=example.com/admin"),
        config,
        {} as any,
      ),
    ).toThrow(InvalidHostnameError);
  });
});
