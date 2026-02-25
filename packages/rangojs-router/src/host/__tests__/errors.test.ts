import { describe, it, expect } from "vitest";
import {
  HostRouterError,
  InvalidPatternError,
  HostOverrideNotAllowedError,
  InvalidHostnameError,
  HostValidationError,
  NoRouteMatchError,
} from "../errors";

describe("HostRouterError", () => {
  it("should create base error", () => {
    const error = new HostRouterError("test error");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HostRouterError);
    expect(error.message).toBe("test error");
    expect(error.name).toBe("HostRouterError");
  });

  it("should support cause", () => {
    const cause = new Error("original error");
    const error = new HostRouterError("wrapped error", { cause });

    expect(error.cause).toBe(cause);
  });
});

describe("InvalidPatternError", () => {
  it("should create pattern error", () => {
    const error = new InvalidPatternError("bad pattern", "invalid format");

    expect(error).toBeInstanceOf(HostRouterError);
    expect(error).toBeInstanceOf(InvalidPatternError);
    expect(error.message).toContain("bad pattern");
    expect(error.message).toContain("invalid format");
    expect(error.name).toBe("InvalidPatternError");
  });

  it("should support cause", () => {
    const cause = new Error("parse error");
    const error = new InvalidPatternError("pattern", "failed", { cause });

    expect(error.cause).toBe(cause);
  });
});

describe("HostOverrideNotAllowedError", () => {
  it("should create override error", () => {
    const error = new HostOverrideNotAllowedError(
      "production.com",
      "x-requested-host",
    );

    expect(error).toBeInstanceOf(HostRouterError);
    expect(error.message).toContain("production.com");
    expect(error.message).toContain("x-requested-host");
    expect(error.name).toBe("HostOverrideNotAllowedError");
  });
});

describe("InvalidHostnameError", () => {
  it("should create hostname error", () => {
    const error = new InvalidHostnameError("invalid..hostname");

    expect(error).toBeInstanceOf(HostRouterError);
    expect(error.message).toContain("invalid..hostname");
    expect(error.name).toBe("InvalidHostnameError");
  });

  it("should support cause", () => {
    const cause = new TypeError("Invalid URL");
    const error = new InvalidHostnameError("bad", { cause });

    expect(error.cause).toBe(cause);
  });
});

describe("HostValidationError", () => {
  it("should create validation error", () => {
    const error = new HostValidationError("validation failed");

    expect(error).toBeInstanceOf(HostRouterError);
    expect(error.message).toBe("validation failed");
    expect(error.name).toBe("HostValidationError");
  });

  it("should support cause", () => {
    const cause = new Error("custom validation");
    const error = new HostValidationError("failed", cause);

    expect(error.cause).toBe(cause);
  });
});

describe("NoRouteMatchError", () => {
  it("should create no match error", () => {
    const error = new NoRouteMatchError("example.com", "/admin");

    expect(error).toBeInstanceOf(HostRouterError);
    expect(error.message).toContain("example.com");
    expect(error.message).toContain("/admin");
    expect(error.name).toBe("NoRouteMatchError");
  });
});
