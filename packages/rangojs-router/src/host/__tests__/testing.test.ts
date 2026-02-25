import { describe, it, expect } from "vitest";
import { createTestRequest, testPattern } from "../testing";

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
});
