import { describe, expect, it } from "vitest";
import {
  diagnosticSearchNames,
  isDiagnosticCredentialKey,
  sanitizeDiagnosticText,
  serializeDiagnosticError,
} from "../redaction.js";

describe("diagnostic redaction", () => {
  it("redacts URL queries and credential-shaped values before retention", () => {
    const sanitized = sanitizeDiagnosticText(
      "https://user:pass@example.test/a?token=secret&view=full Authorization: Bearer abc123 password=hunter2 session=abc jwt=def set-cookie=sid%3Dghi",
    );

    expect(sanitized).not.toContain("user:pass");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("abc");
    expect(sanitized).not.toContain("def");
    expect(sanitized).not.toContain("ghi");
    expect(sanitized).toContain("token=[redacted]");
    expect(sanitized).toContain("password=[redacted]");
  });

  it("retains only bounded search parameter names", () => {
    const url = new URL(
      "http://localhost/products?token=secret&view=grid&view=list",
    );
    expect(diagnosticSearchNames(url)).toEqual(["token", "view"]);
  });

  it.each([
    "cookie",
    "cookies",
    "Cookie",
    "set-cookie",
    "set cookies",
    "set_cookie",
    "api key",
    "cf-access-jwt-assertion",
  ])("classifies structured %s fields as credentials", (key) => {
    expect(isDiagnosticCredentialKey(key)).toBe(true);
  });

  it("redacts spaced and plural credential assignments", () => {
    const sanitized = sanitizeDiagnosticText(
      "cookies: sid=visible\napi key=also-visible\nset cookies=session=visible\njwt assertion=visible",
    );

    expect(sanitized).not.toContain("visible");
    expect(sanitized).not.toContain("also-visible");
  });

  it.each(["author", "authority", "tokenizer", "sessionCount"])(
    "does not classify ordinary %s fields as credentials",
    (key) => {
      expect(isDiagnosticCredentialKey(key)).toBe(false);
    },
  );

  it("serializes bounded errors with project-relative, redacted stacks", () => {
    const error = new Error("token=secret");
    error.stack = `${process.cwd()}/src/route.ts?key=value:1:2\nAuthorization: Bearer abc`;

    const serialized = serializeDiagnosticError(error);
    expect(serialized.message).toBe("token=[redacted]");
    expect(serialized.stack).toContain("./src/route.ts?key=[redacted]");
    expect(serialized.stack).not.toContain(process.cwd());
    expect(serialized.stack).not.toContain("Bearer abc");
  });

  it("bounds large input before applying redaction", () => {
    const sanitized = sanitizeDiagnosticText(
      `password=hunter2 ${"x".repeat(1024 * 1024)}`,
      256,
    );

    expect(new TextEncoder().encode(sanitized).byteLength).toBeLessThanOrEqual(
      256,
    );
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).toContain("password=[redacted]");
  });

  it("redacts URL userinfo when bounding removes the at-sign", () => {
    const sanitized = sanitizeDiagnosticText(
      `https://user:secret${"x".repeat(1024)}@example.test`,
      128,
    );

    expect(sanitized).toBe("https://[redacted]...");
    expect(sanitized).not.toContain("secret");
  });
});
