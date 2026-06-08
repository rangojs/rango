import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoader } from "../loader.js";
import { createHandle } from "../handle.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the call to throw");
}

describe("createLoader missing $$id guard", () => {
  it("throws outside a test runner (a real build) when __injectedId is missing", () => {
    vi.stubEnv("VITEST", "");
    expect(() => createLoader(async () => ({ data: 1 }))).toThrow(
      "Loader is missing $$id",
    );
  });

  it("gives located, actionable guidance for a non-exported loader", () => {
    vi.stubEnv("VITEST", "");
    const msg = messageOf(() => createLoader(async () => ({ data: 1 })));
    expect(msg).toContain("Loader is missing $$id");
    expect(msg).toContain("export const X = createLoader(...)");
    expect(msg).toContain("export it as `export const`");
    expect(msg).toContain('"Unsupported createLoader shape"');
    // Best-effort call site parsed from the stack: "path:line:column".
    expect(msg).toMatch(/created at .+:\d+:\d+/);
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
  it("throws outside a test runner (a real build) when __injectedId is missing", () => {
    vi.stubEnv("VITEST", "");
    expect(() => createHandle()).toThrow("Handle is missing $$id");
  });

  it("gives located, actionable guidance for a non-exported handle", () => {
    vi.stubEnv("VITEST", "");
    const msg = messageOf(() => createHandle());
    expect(msg).toContain("Handle is missing $$id");
    expect(msg).toContain("export const X = createHandle(...)");
    expect(msg).toContain('"Unsupported createHandle shape"');
    expect(msg).toMatch(/created at .+:\d+:\d+/);
  });

  it("succeeds when __injectedId is provided", () => {
    vi.stubEnv("NODE_ENV", "development");
    const handle = (createHandle as Function)(undefined, "test-file#MyHandle");
    expect(handle.$$id).toBe("test-file#MyHandle");
  });
});
