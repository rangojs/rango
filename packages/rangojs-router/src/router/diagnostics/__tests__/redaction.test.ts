import { describe, expect, it } from "vitest";
import {
  diagnosticSearchNames,
  sanitizeDiagnosticText,
  serializeDiagnosticError,
} from "../redaction.js";

describe("diagnostic redaction", () => {
  it("redacts URL queries and credential-shaped values before retention", () => {
    const sanitized = sanitizeDiagnosticText(
      "https://user:pass@example.test/a?token=secret&view=full Authorization: Bearer abc123 password=hunter2",
    );

    expect(sanitized).not.toContain("user:pass");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).toContain("token=[redacted]");
    expect(sanitized).toContain("password=[redacted]");
  });

  it("retains only bounded search parameter names", () => {
    const url = new URL(
      "http://localhost/products?token=secret&view=grid&view=list",
    );
    expect(diagnosticSearchNames(url)).toEqual(["token", "view"]);
  });

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
