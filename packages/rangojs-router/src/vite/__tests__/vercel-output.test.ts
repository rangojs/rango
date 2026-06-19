import { describe, it, expect } from "vitest";
import { assertVercelNodeRuntime } from "../plugins/vercel-output.js";

describe("assertVercelNodeRuntime", () => {
  it("accepts an omitted runtime (defaults to nodejs)", () => {
    expect(() => assertVercelNodeRuntime(undefined)).not.toThrow();
  });

  it("accepts any nodejs* runtime", () => {
    expect(() => assertVercelNodeRuntime("nodejs22.x")).not.toThrow();
    expect(() => assertVercelNodeRuntime("nodejs20.x")).not.toThrow();
  });

  it("rejects the edge runtime with a clear error", () => {
    expect(() => assertVercelNodeRuntime("edge")).toThrow(
      /runtime "edge" is not supported.*Edge runtime is not supported/s,
    );
  });

  it("rejects any non-nodejs runtime", () => {
    expect(() => assertVercelNodeRuntime("python3.12")).toThrow(
      /not supported/,
    );
  });
});
