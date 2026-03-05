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

describe("validateRedirectOrigin – payload redirect boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks cross-origin payload redirect URLs the same way as header redirects", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Simulate what server-action-bridge does: validate the payload redirect URL
    // before using it for navigation or window.location.href assignment.
    const payloadRedirectUrl = "https://evil.com/steal-cookies";
    const origin = "http://localhost:3000";

    const result = validateRedirectOrigin(payloadRedirectUrl, origin);
    expect(result).toBeNull();
  });

  it("allows same-origin payload redirect URLs", () => {
    const payloadRedirectUrl = "/dashboard?welcome=true";
    const origin = "http://localhost:3000";

    const result = validateRedirectOrigin(payloadRedirectUrl, origin);
    expect(result).toBe("/dashboard?welcome=true");
  });

  it("blocks protocol-relative payload redirect URLs", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const payloadRedirectUrl = "//evil.com/phish";
    const origin = "http://localhost:3000";

    const result = validateRedirectOrigin(payloadRedirectUrl, origin);
    expect(result).toBeNull();
  });
});
