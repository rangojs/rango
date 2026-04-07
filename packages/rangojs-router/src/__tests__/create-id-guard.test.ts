import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoader } from "../loader.js";
import { createHandle } from "../handle.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createLoader missing $$id guard", () => {
  it("throws in development when __injectedId is missing", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => createLoader(async () => ({ data: 1 }))).toThrow(
      "Loader is missing $$id",
    );
  });

  it("succeeds when __injectedId is provided", () => {
    vi.stubEnv("NODE_ENV", "development");
    const loader = (createLoader as Function)(
      async () => ({ data: 1 }),
      undefined,
      "test-file#MyLoader",
    );
    expect(loader.$$id).toBe("test-file#MyLoader");
  });
});

describe("createHandle missing $$id guard", () => {
  it("throws in development when __injectedId is missing", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => createHandle()).toThrow("Handle is missing $$id");
  });

  it("succeeds when __injectedId is provided", () => {
    vi.stubEnv("NODE_ENV", "development");
    const handle = (createHandle as Function)(undefined, "test-file#MyHandle");
    expect(handle.$$id).toBe("test-file#MyHandle");
  });
});
