import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSegmentStructure } from "../browser/segment-structure-assert";

const originalNodeEnv = process.env.NODE_ENV;

describe("assertSegmentStructure", () => {
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it("warns in development when loading category changes", () => {
    process.env.NODE_ENV = "development";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    assertSegmentStructure(
      { id: "layout", loading: false } as any,
      { id: "layout", loading: "<Skeleton />" } as any,
      "merge",
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
      "Tree structure mismatch detected in merge",
    );
  });

  it("warns in development when mountPath presence changes", () => {
    process.env.NODE_ENV = "development";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    assertSegmentStructure(
      { id: "layout", mountPath: undefined } as any,
      { id: "layout", mountPath: "@modal" } as any,
      "merge",
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
      "MountContextProvider mismatch detected in merge",
    );
  });

  it("does nothing in production", () => {
    process.env.NODE_ENV = "production";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    assertSegmentStructure(
      { id: "layout", loading: false } as any,
      { id: "layout", loading: "<Skeleton />", mountPath: "x" } as any,
      "merge",
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
