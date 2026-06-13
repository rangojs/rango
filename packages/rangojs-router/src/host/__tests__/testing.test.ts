import { describe, it, expect } from "vitest";
import { createTestRequest, testPattern, matchesHost } from "../testing";

describe("createTestRequest", () => {
  it("should create a request with specified host", () => {
    const request = createTestRequest({ host: "example.com" });

    expect(request.url).toBe("http://example.com/");
    expect(new URL(request.url).hostname).toBe("example.com");
  });

  it("should create a request with path", () => {
    const request = createTestRequest({
      host: "example.com",
      path: "/admin",
    });

    expect(request.url).toBe("http://example.com/admin");
  });

  it("should create a request with cookies", () => {
    const request = createTestRequest({
      host: "localhost",
      cookies: {
        "x-requested-host": "admin.example.com",
        session: "abc123",
      },
    });

    const cookieHeader = request.headers.get("cookie");
    expect(cookieHeader).toBeTruthy();
    expect(cookieHeader).toContain("x-requested-host=admin.example.com");
    expect(cookieHeader).toContain("session=abc123");
  });

  it("should create a request with custom method", () => {
    const request = createTestRequest({
      host: "example.com",
      method: "POST",
    });

    expect(request.method).toBe("POST");
  });

  it("should create a request with custom headers", () => {
    const request = createTestRequest({
      host: "example.com",
      headers: {
        Authorization: "Bearer token",
      },
    });

    expect(request.headers.get("Authorization")).toBe("Bearer token");
  });
});

describe("testPattern", () => {
  it("should test single patterns", () => {
    expect(testPattern(".", "example.com")).toBe(true);
    expect(testPattern(".", "www.example.com")).toBe(false);

    expect(testPattern("admin.*", "admin.example.com")).toBe(true);
    expect(testPattern("admin.*", "example.com")).toBe(false);
  });

  it("should test pattern arrays", () => {
    expect(testPattern([".", "www.*"], "example.com")).toBe(true);
    expect(testPattern([".", "www.*"], "www.example.com")).toBe(true);
    expect(testPattern([".", "www.*"], "api.example.com")).toBe(false);
  });

  it("should test complex patterns", () => {
    expect(testPattern("*.", "api.example.com")).toBe(true);
    expect(testPattern("**.", "a.b.example.com")).toBe(true);
    expect(testPattern("**", "any.host.example.com")).toBe(true);
  });

  describe("path-based patterns (T4)", () => {
    it("matches a path-based pattern when the pathname is supplied", () => {
      expect(testPattern("example.com/admin", "example.com", "/admin")).toBe(
        true,
      );
      // prefix match
      expect(
        testPattern("example.com/admin", "example.com", "/admin/users"),
      ).toBe(true);
      // wrong path
      expect(testPattern("example.com/admin", "example.com", "/api")).toBe(
        false,
      );
    });

    it("never matches a path-based pattern without a pathname (the bug T4 fixes)", () => {
      // pathname defaults to "/", which is not under "/admin".
      expect(testPattern("example.com/admin", "example.com")).toBe(false);
    });

    it("matches a wildcard host + path pattern", () => {
      expect(
        testPattern("**.workers.dev/admin", "foo.workers.dev", "/admin"),
      ).toBe(true);
      expect(
        testPattern("**.workers.dev/admin", "foo.workers.dev", "/public"),
      ).toBe(false);
    });

    it("stays backward-compatible for host-only patterns (no pathname arg)", () => {
      expect(testPattern("admin.*", "admin.example.com")).toBe(true);
    });
  });
});

describe("matchesHost (T4 — pattern vs a Request)", () => {
  it("matches hostname + pathname taken from the request URL", () => {
    expect(
      matchesHost(
        "**.workers.dev/admin",
        new Request("https://foo.workers.dev/admin"),
      ),
    ).toBe(true);
    expect(
      matchesHost("example.com/admin", new Request("http://example.com/api")),
    ).toBe(false);
  });

  it("accepts a pattern array", () => {
    expect(
      matchesHost(
        ["admin.*", "example.com/shop"],
        new Request("http://example.com/shop/cart"),
      ),
    ).toBe(true);
  });
});
