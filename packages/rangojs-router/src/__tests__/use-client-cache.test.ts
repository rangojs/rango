import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock react before importing the hook
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useContext: vi.fn(),
    useCallback: vi.fn((fn: Function) => fn),
  };
});

import { useContext } from "react";
import { useClientCache } from "../browser/react/use-client-cache.js";

const mockedUseContext = vi.mocked(useContext);

describe("useClientCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when used outside NavigationProvider", () => {
    mockedUseContext.mockReturnValue(null);
    expect(() => useClientCache()).toThrow(
      "useClientCache must be used within NavigationProvider",
    );
  });

  it("returns clear function when context is available", () => {
    const clearHistoryCache = vi.fn();
    mockedUseContext.mockReturnValue({
      store: { clearHistoryCache },
    } as any);

    const { clear } = useClientCache();
    clear();
    expect(clearHistoryCache).toHaveBeenCalledOnce();
  });
});
