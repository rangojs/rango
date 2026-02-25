import { describe, it, expect } from "vitest";
import {
  matchPattern,
  normalizePattern,
  validatePattern,
  parseRequest,
} from "../pattern-matcher";

describe("normalizePattern", () => {
  it("should remove trailing slash from path patterns", () => {
    expect(normalizePattern("example.com/admin/")).toBe("example.com/admin");
    expect(normalizePattern("./admin/")).toBe("./admin");
    expect(normalizePattern("admin.*/blog/")).toBe("admin.*/blog");
  });

  it("should not modify patterns without paths", () => {
    expect(normalizePattern("example.com")).toBe("example.com");
    expect(normalizePattern("admin.*")).toBe("admin.*");
    expect(normalizePattern("*.")).toBe("*.");
  });

  it("should not modify patterns with paths without trailing slash", () => {
    expect(normalizePattern("example.com/admin")).toBe("example.com/admin");
    expect(normalizePattern("./api")).toBe("./api");
  });
});

describe("parseRequest", () => {
  it("should parse hostname and pathname", () => {
    const request = new Request("http://example.com/path");
    const result = parseRequest(request);

    expect(result.hostname).toBe("example.com");
    expect(result.pathname).toBe("/path");
    expect(result.parts).toEqual(["example", "com"]);
  });

  it("should parse subdomain correctly", () => {
    const request = new Request("http://www.example.com/");
    const result = parseRequest(request);

    expect(result.hostname).toBe("www.example.com");
    expect(result.parts).toEqual(["www", "example", "com"]);
  });
});

describe("matchPattern - Apex Domains", () => {
  it("should match `.` to apex domains only", () => {
    expect(matchPattern(".", "example.com", "/", ["example", "com"])).toBe(
      true,
    );
    expect(matchPattern(".", "google.com", "/", ["google", "com"])).toBe(true);
    expect(
      matchPattern(".", "www.example.com", "/", ["www", "example", "com"]),
    ).toBe(false);
  });

  it("should match `*` to apex domains only", () => {
    expect(matchPattern("*", "example.com", "/", ["example", "com"])).toBe(
      true,
    );
    expect(
      matchPattern("*", "www.example.com", "/", ["www", "example", "com"]),
    ).toBe(false);
  });

  it("should match `**` to any domain", () => {
    expect(matchPattern("**", "example.com", "/", ["example", "com"])).toBe(
      true,
    );
    expect(
      matchPattern("**", "www.example.com", "/", ["www", "example", "com"]),
    ).toBe(true);
    expect(
      matchPattern("**", "a.b.c.example.com", "/", [
        "a",
        "b",
        "c",
        "example",
        "com",
      ]),
    ).toBe(true);
  });
});

describe("matchPattern - Subdomains", () => {
  it("should match `*.` to single-level subdomains only", () => {
    expect(
      matchPattern("*.", "www.example.com", "/", ["www", "example", "com"]),
    ).toBe(true);
    expect(
      matchPattern("*.", "api.example.com", "/", ["api", "example", "com"]),
    ).toBe(true);
    expect(matchPattern("*.", "example.com", "/", ["example", "com"])).toBe(
      false,
    );
    expect(
      matchPattern("*.", "a.b.example.com", "/", ["a", "b", "example", "com"]),
    ).toBe(false);
  });

  it("should match `**.` to multi-level subdomains only", () => {
    expect(
      matchPattern("**.", "a.b.example.com", "/", ["a", "b", "example", "com"]),
    ).toBe(true);
    expect(
      matchPattern("**.", "x.y.z.example.com", "/", [
        "x",
        "y",
        "z",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(matchPattern("**.", "example.com", "/", ["example", "com"])).toBe(
      false,
    );
    expect(
      matchPattern("**.", "www.example.com", "/", ["www", "example", "com"]),
    ).toBe(false);
  });
});

describe("matchPattern - Specific Domains", () => {
  it("should match exact domains", () => {
    expect(
      matchPattern("example.com", "example.com", "/", ["example", "com"]),
    ).toBe(true);
    expect(
      matchPattern("example.com", "google.com", "/", ["google", "com"]),
    ).toBe(false);
    expect(
      matchPattern("www.example.com", "www.example.com", "/", [
        "www",
        "example",
        "com",
      ]),
    ).toBe(true);
  });

  it("should match `*.com` to any apex .com domain", () => {
    expect(matchPattern("*.com", "example.com", "/", ["example", "com"])).toBe(
      true,
    );
    expect(matchPattern("*.com", "google.com", "/", ["google", "com"])).toBe(
      true,
    );
    expect(matchPattern("*.com", "example.net", "/", ["example", "net"])).toBe(
      false,
    );
    expect(
      matchPattern("*.com", "www.example.com", "/", ["www", "example", "com"]),
    ).toBe(false);
  });

  it("should match `*.example.com` to single subdomains", () => {
    expect(
      matchPattern("*.example.com", "api.example.com", "/", [
        "api",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("*.example.com", "www.example.com", "/", [
        "www",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("*.example.com", "example.com", "/", ["example", "com"]),
    ).toBe(false);
    expect(
      matchPattern("*.example.com", "a.b.example.com", "/", [
        "a",
        "b",
        "example",
        "com",
      ]),
    ).toBe(false);
  });

  it("should match `**.example.com` to any depth subdomains", () => {
    expect(
      matchPattern("**.example.com", "api.example.com", "/", [
        "api",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("**.example.com", "a.b.c.example.com", "/", [
        "a",
        "b",
        "c",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("**.example.com", "example.com", "/", ["example", "com"]),
    ).toBe(false);
  });

  it("should match `admin.*` to admin subdomain of any apex", () => {
    expect(
      matchPattern("admin.*", "admin.example.com", "/", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin.*", "admin.google.com", "/", [
        "admin",
        "google",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin.*", "example.com", "/", ["example", "com"]),
    ).toBe(false);
    expect(
      matchPattern("admin.*", "admin.sub.example.com", "/", [
        "admin",
        "sub",
        "example",
        "com",
      ]),
    ).toBe(false);
  });

  it("should match `admin.**` to admin subdomain of any domain", () => {
    expect(
      matchPattern("admin.**", "admin.example.com", "/", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin.**", "admin.sub.example.com", "/", [
        "admin",
        "sub",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin.**", "example.com", "/", ["example", "com"]),
    ).toBe(false);
  });
});

describe("matchPattern - Path Patterns", () => {
  it("should match specific domain with path", () => {
    expect(
      matchPattern("example.com/admin", "example.com", "/admin", [
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("example.com/admin", "example.com", "/admin/users", [
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("example.com/admin", "example.com", "/api", [
        "example",
        "com",
      ]),
    ).toBe(false);
    expect(
      matchPattern("example.com/admin", "www.example.com", "/admin", [
        "www",
        "example",
        "com",
      ]),
    ).toBe(false);
  });

  it("should match apex with path pattern", () => {
    expect(
      matchPattern("./admin", "example.com", "/admin", ["example", "com"]),
    ).toBe(true);
    expect(
      matchPattern("./admin", "example.com", "/admin/users", [
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("./admin", "google.com", "/admin", ["google", "com"]),
    ).toBe(true);
    expect(
      matchPattern("./admin", "example.com", "/api", ["example", "com"]),
    ).toBe(false);
    expect(
      matchPattern("./admin", "www.example.com", "/admin", [
        "www",
        "example",
        "com",
      ]),
    ).toBe(false);
  });

  it("should match subdomain with path pattern", () => {
    expect(
      matchPattern("*./api", "api.example.com", "/api", [
        "api",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("*./api", "api.example.com", "/api/v2", [
        "api",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("*./api", "example.com", "/api", ["example", "com"]),
    ).toBe(false);
  });

  it("should match specific subdomain with path", () => {
    expect(
      matchPattern("admin./blog", "admin.example.com", "/blog", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin./blog", "admin.example.com", "/blog/post-1", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("admin./blog", "admin.example.com", "/api", [
        "admin",
        "example",
        "com",
      ]),
    ).toBe(false);
  });

  it("should match any domain with path", () => {
    expect(
      matchPattern("**/dashboard", "example.com", "/dashboard", [
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("**/dashboard", "www.example.com", "/dashboard", [
        "www",
        "example",
        "com",
      ]),
    ).toBe(true);
    expect(
      matchPattern("**/dashboard", "example.com", "/admin", ["example", "com"]),
    ).toBe(false);
  });
});

describe("validatePattern", () => {
  it("should accept valid patterns", () => {
    expect(() => validatePattern("example.com")).not.toThrow();
    expect(() => validatePattern("admin.*")).not.toThrow();
    expect(() => validatePattern("*.")).not.toThrow();
    expect(() => validatePattern("./admin")).not.toThrow();
  });

  it("should reject patterns with spaces", async () => {
    const { InvalidPatternError } = await import("../errors");
    expect(() => validatePattern("example .com")).toThrow(InvalidPatternError);
    expect(() => validatePattern("admin. *")).toThrow(InvalidPatternError);
  });

  it("should reject empty patterns", async () => {
    const { InvalidPatternError } = await import("../errors");
    expect(() => validatePattern("")).toThrow(InvalidPatternError);
  });
});
