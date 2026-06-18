import { describe, expect, it } from "vitest";
import { getCookie, parseCookies } from "../cookie-handler.js";

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
