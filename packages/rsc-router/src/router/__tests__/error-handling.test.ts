import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  findNearestErrorBoundary,
  findNearestNotFoundBoundary,
  createErrorInfo,
  createNotFoundInfo,
} from "../error-handling";
import type { EntryData } from "../../server/context";
import type { ErrorBoundaryHandler, NotFoundBoundaryHandler } from "../../types";
import React from "react";

// Helper to create minimal EntryData for testing
const createEntry = (
  overrides: Partial<EntryData> = {}
): EntryData =>
  ({
    type: "layout",
    id: "test-entry",
    shortCode: "L0",
    handler: null,
    errorBoundary: [],
    notFoundBoundary: [],
    middleware: [],
    revalidate: [],
    loader: [],
    layout: [],
    parallel: [],
    intercept: [],
    parent: null,
    ...overrides,
  } as unknown as EntryData);

describe("findNearestErrorBoundary", () => {
  describe("single entry", () => {
    it("should return null when no error boundary defined", () => {
      const entry = createEntry({ errorBoundary: [] });
      const result = findNearestErrorBoundary(entry);
      expect(result).toBeNull();
    });

    it("should return error boundary when defined on entry", () => {
      const fallback = React.createElement("div", null, "Error occurred");
      const entry = createEntry({ errorBoundary: [fallback] });

      const result = findNearestErrorBoundary(entry);
      expect(result).toBe(fallback);
    });

    it("should return last error boundary when multiple defined", () => {
      const fallback1 = React.createElement("div", null, "Error 1");
      const fallback2 = React.createElement("div", null, "Error 2");
      const entry = createEntry({ errorBoundary: [fallback1, fallback2] });

      const result = findNearestErrorBoundary(entry);
      expect(result).toBe(fallback2);
    });

    it("should return handler function when error boundary is a function", () => {
      const handler: ErrorBoundaryHandler = ({ error }) =>
        React.createElement("div", null, error.message);
      const entry = createEntry({ errorBoundary: [handler] });

      const result = findNearestErrorBoundary(entry);
      expect(result).toBe(handler);
    });
  });

  describe("parent chain traversal", () => {
    it("should find error boundary in parent entry", () => {
      const fallback = React.createElement("div", null, "Parent error");
      const parent = createEntry({ errorBoundary: [fallback] });
      const child = createEntry({ parent, errorBoundary: [] });

      const result = findNearestErrorBoundary(child);
      expect(result).toBe(fallback);
    });

    it("should find nearest error boundary (child wins over parent)", () => {
      const parentFallback = React.createElement("div", null, "Parent error");
      const childFallback = React.createElement("div", null, "Child error");
      const parent = createEntry({ errorBoundary: [parentFallback] });
      const child = createEntry({ parent, errorBoundary: [childFallback] });

      const result = findNearestErrorBoundary(child);
      expect(result).toBe(childFallback);
    });

    it("should traverse multiple levels to find error boundary", () => {
      const fallback = React.createElement("div", null, "Root error");
      const root = createEntry({ errorBoundary: [fallback] });
      const middle = createEntry({ parent: root, errorBoundary: [] });
      const leaf = createEntry({ parent: middle, errorBoundary: [] });

      const result = findNearestErrorBoundary(leaf);
      expect(result).toBe(fallback);
    });
  });

  describe("orphan layouts", () => {
    it("should find error boundary in orphan layout", () => {
      const orphanFallback = React.createElement("div", null, "Orphan error");
      const orphanLayout = createEntry({
        type: "layout",
        errorBoundary: [orphanFallback],
      });
      const entry = createEntry({
        layout: [orphanLayout],
        errorBoundary: [],
      });

      const result = findNearestErrorBoundary(entry);
      expect(result).toBe(orphanFallback);
    });

    it("should prefer entry error boundary over orphan layout", () => {
      const entryFallback = React.createElement("div", null, "Entry error");
      const orphanFallback = React.createElement("div", null, "Orphan error");
      const orphanLayout = createEntry({
        type: "layout",
        errorBoundary: [orphanFallback],
      });
      const entry = createEntry({
        layout: [orphanLayout],
        errorBoundary: [entryFallback],
      });

      const result = findNearestErrorBoundary(entry);
      expect(result).toBe(entryFallback);
    });

    it("should check orphan layouts in order", () => {
      const orphan1Fallback = React.createElement("div", null, "Orphan 1");
      const orphan2Fallback = React.createElement("div", null, "Orphan 2");
      const orphan1 = createEntry({ errorBoundary: [orphan1Fallback] });
      const orphan2 = createEntry({ errorBoundary: [orphan2Fallback] });
      const entry = createEntry({
        layout: [orphan1, orphan2],
        errorBoundary: [],
      });

      const result = findNearestErrorBoundary(entry);
      expect(result).toBe(orphan1Fallback);
    });
  });

  describe("default error boundary", () => {
    it("should return default error boundary when no boundary found", () => {
      const defaultFallback = React.createElement("div", null, "Default error");
      const entry = createEntry({ errorBoundary: [] });

      const result = findNearestErrorBoundary(entry, defaultFallback);
      expect(result).toBe(defaultFallback);
    });

    it("should prefer found error boundary over default", () => {
      const foundFallback = React.createElement("div", null, "Found error");
      const defaultFallback = React.createElement("div", null, "Default error");
      const entry = createEntry({ errorBoundary: [foundFallback] });

      const result = findNearestErrorBoundary(entry, defaultFallback);
      expect(result).toBe(foundFallback);
    });

    it("should return null when no boundary and no default", () => {
      const entry = createEntry({ errorBoundary: [] });
      const result = findNearestErrorBoundary(entry);
      expect(result).toBeNull();
    });
  });

  describe("null entry", () => {
    it("should return default when entry is null", () => {
      const defaultFallback = React.createElement("div", null, "Default");
      const result = findNearestErrorBoundary(null, defaultFallback);
      expect(result).toBe(defaultFallback);
    });

    it("should return null when entry is null and no default", () => {
      const result = findNearestErrorBoundary(null);
      expect(result).toBeNull();
    });
  });
});

describe("findNearestNotFoundBoundary", () => {
  describe("single entry", () => {
    it("should return null when no notFound boundary defined", () => {
      const entry = createEntry({ notFoundBoundary: [] });
      const result = findNearestNotFoundBoundary(entry);
      expect(result).toBeNull();
    });

    it("should return notFound boundary when defined on entry", () => {
      const fallback = React.createElement("div", null, "Not found");
      const entry = createEntry({ notFoundBoundary: [fallback] });

      const result = findNearestNotFoundBoundary(entry);
      expect(result).toBe(fallback);
    });

    it("should return last notFound boundary when multiple defined", () => {
      const fallback1 = React.createElement("div", null, "Not found 1");
      const fallback2 = React.createElement("div", null, "Not found 2");
      const entry = createEntry({ notFoundBoundary: [fallback1, fallback2] });

      const result = findNearestNotFoundBoundary(entry);
      expect(result).toBe(fallback2);
    });
  });

  describe("parent chain traversal", () => {
    it("should find notFound boundary in parent", () => {
      const fallback = React.createElement("div", null, "Parent not found");
      const parent = createEntry({ notFoundBoundary: [fallback] });
      const child = createEntry({ parent, notFoundBoundary: [] });

      const result = findNearestNotFoundBoundary(child);
      expect(result).toBe(fallback);
    });

    it("should find nearest notFound boundary (child wins)", () => {
      const parentFallback = React.createElement("div", null, "Parent");
      const childFallback = React.createElement("div", null, "Child");
      const parent = createEntry({ notFoundBoundary: [parentFallback] });
      const child = createEntry({ parent, notFoundBoundary: [childFallback] });

      const result = findNearestNotFoundBoundary(child);
      expect(result).toBe(childFallback);
    });
  });

  describe("default notFound boundary", () => {
    it("should return default when no boundary found", () => {
      const defaultFallback = React.createElement("div", null, "Default 404");
      const entry = createEntry({ notFoundBoundary: [] });

      const result = findNearestNotFoundBoundary(entry, defaultFallback);
      expect(result).toBe(defaultFallback);
    });
  });
});

describe("createErrorInfo", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe("Error objects", () => {
    it("should extract message from Error", () => {
      const error = new Error("Something went wrong");
      const info = createErrorInfo(error, "segment-1", "loader");

      expect(info.message).toBe("Something went wrong");
      expect(info.name).toBe("Error");
    });

    it("should extract name from custom error", () => {
      class CustomError extends Error {
        name = "CustomError";
      }
      const error = new CustomError("Custom error");
      const info = createErrorInfo(error, "segment-1", "route");

      expect(info.name).toBe("CustomError");
    });

    it("should extract code from error with code property", () => {
      const error = new Error("Not found");
      (error as any).code = "NOT_FOUND";
      const info = createErrorInfo(error, "segment-1", "middleware");

      expect(info.code).toBe("NOT_FOUND");
    });

    it("should include stack in development", () => {
      process.env.NODE_ENV = "development";
      const error = new Error("Dev error");
      const info = createErrorInfo(error, "segment-1", "layout");

      expect(info.stack).toBeDefined();
      expect(info.stack).toContain("Dev error");
    });

    it("should exclude stack in production", () => {
      process.env.NODE_ENV = "production";
      const error = new Error("Prod error");
      const info = createErrorInfo(error, "segment-1", "layout");

      expect(info.stack).toBeUndefined();
    });

    it("should include cause in development", () => {
      process.env.NODE_ENV = "development";
      const cause = new Error("Root cause");
      const error = new Error("Wrapper error", { cause });
      const info = createErrorInfo(error, "segment-1", "route");

      expect(info.cause).toBe(cause);
    });

    it("should exclude cause in production", () => {
      process.env.NODE_ENV = "production";
      const cause = new Error("Root cause");
      const error = new Error("Wrapper error", { cause });
      const info = createErrorInfo(error, "segment-1", "route");

      expect(info.cause).toBeUndefined();
    });

    it("should sanitize message in production", () => {
      process.env.NODE_ENV = "production";
      const error = new Error("Sensitive database connection string");
      const info = createErrorInfo(error, "segment-1", "loader");

      expect(info.message).toBe("An error occurred");
    });
  });

  describe("non-Error values", () => {
    it("should handle string thrown", () => {
      process.env.NODE_ENV = "development";
      const info = createErrorInfo("String error", "segment-1", "route");

      expect(info.message).toBe("String error");
      expect(info.name).toBe("Error");
    });

    it("should handle object thrown", () => {
      process.env.NODE_ENV = "development";
      const info = createErrorInfo({ foo: "bar" }, "segment-1", "route");

      expect(info.message).toBe("[object Object]");
      expect(info.name).toBe("Error");
    });

    it("should handle null thrown", () => {
      process.env.NODE_ENV = "development";
      const info = createErrorInfo(null, "segment-1", "route");

      expect(info.message).toBe("null");
      expect(info.name).toBe("Error");
    });

    it("should sanitize non-Error in production", () => {
      process.env.NODE_ENV = "production";
      const info = createErrorInfo("Sensitive info", "segment-1", "route");

      expect(info.message).toBe("An error occurred");
    });
  });

  describe("segment info", () => {
    it("should include segmentId", () => {
      const info = createErrorInfo(new Error("test"), "my-segment-id", "loader");
      expect(info.segmentId).toBe("my-segment-id");
    });

    it("should include segmentType", () => {
      const info = createErrorInfo(new Error("test"), "segment-1", "middleware");
      expect(info.segmentType).toBe("middleware");
    });

    it("should handle all segment types", () => {
      const types: Array<"layout" | "route" | "parallel" | "loader" | "middleware"> = [
        "layout",
        "route",
        "parallel",
        "loader",
        "middleware",
      ];

      types.forEach((type) => {
        const info = createErrorInfo(new Error("test"), "segment", type);
        expect(info.segmentType).toBe(type);
      });
    });
  });
});

describe("createNotFoundInfo", () => {
  it("should create NotFoundInfo with message", () => {
    const error = { message: "Product not found" };
    const info = createNotFoundInfo(error, "product-segment", "loader");

    expect(info.message).toBe("Product not found");
  });

  it("should include segmentId", () => {
    const info = createNotFoundInfo(
      { message: "Not found" },
      "cart-segment",
      "route"
    );

    expect(info.segmentId).toBe("cart-segment");
  });

  it("should include segmentType", () => {
    const info = createNotFoundInfo(
      { message: "Not found" },
      "segment",
      "middleware"
    );

    expect(info.segmentType).toBe("middleware");
  });

  it("should include pathname when provided", () => {
    const info = createNotFoundInfo(
      { message: "Page not found" },
      "segment",
      "route",
      "/products/invalid-slug"
    );

    expect(info.pathname).toBe("/products/invalid-slug");
  });

  it("should handle missing pathname", () => {
    const info = createNotFoundInfo(
      { message: "Not found" },
      "segment",
      "route"
    );

    expect(info.pathname).toBeUndefined();
  });
});
