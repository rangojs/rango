import { describe, it, expect, vi, afterEach } from "vitest";
import { validateRedirectOrigin } from "../browser/validate-redirect-origin";

describe("validateRedirectOrigin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts relative paths", () => {
    expect(validateRedirectOrigin("/about", "http://localhost:3000")).toBe(
      "/about",
    );
  });

  it("accepts same-origin absolute URLs", () => {
    expect(
      validateRedirectOrigin(
        "http://localhost:3000/page",
        "http://localhost:3000",
      ),
    ).toBe("http://localhost:3000/page");
  });

  it("rejects cross-origin absolute URLs", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      validateRedirectOrigin("https://evil.com/phish", "http://localhost:3000"),
    ).toBeNull();
  });

  it("rejects protocol-relative URLs with different origin", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      validateRedirectOrigin("//evil.com/path", "http://localhost:3000"),
    ).toBeNull();
  });

  it("accepts paths with query strings and fragments", () => {
    expect(
      validateRedirectOrigin("/page?q=1#section", "http://localhost:3000"),
    ).toBe("/page?q=1#section");
  });

  it("accepts empty path", () => {
    // new URL("", origin) resolves to origin
    expect(validateRedirectOrigin("", "http://localhost:3000")).toBe("");
  });

  it("rejects URLs with different port (different origin)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      validateRedirectOrigin(
        "http://localhost:9999/page",
        "http://localhost:3000",
      ),
    ).toBeNull();
  });

  it("rejects URLs with different scheme (http vs https)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      validateRedirectOrigin("http://example.com/page", "https://example.com"),
    ).toBeNull();
  });
});
