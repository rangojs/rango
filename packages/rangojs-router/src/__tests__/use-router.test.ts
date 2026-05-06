import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useContext: vi.fn(),
    useMemo: vi.fn((fn: () => unknown) => fn()),
  };
});

import { useContext } from "react";
import { useRouter } from "../browser/react/use-router.js";

const mockedUseContext = vi.mocked(useContext);

interface SetupOptions {
  basename?: string;
  historyState?: unknown;
  navigation?: { canGoBack: boolean } | undefined;
}

function setupWindow(opts: SetupOptions): {
  navigate: ReturnType<typeof vi.fn>;
  historyBack: ReturnType<typeof vi.fn>;
} {
  const navigate = vi.fn().mockResolvedValue(undefined);
  const historyBack = vi.fn();

  mockedUseContext.mockReturnValue({
    store: {} as never,
    eventController: {} as never,
    navigate,
    refresh: vi.fn(),
    version: undefined,
    basename: opts.basename,
  });

  (globalThis as Record<string, unknown>).window = {
    history: {
      get state() {
        return opts.historyState ?? null;
      },
      back: historyBack,
    },
    navigation: opts.navigation,
  };

  return { navigate, historyBack };
}

describe("useRouter().back()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  describe("Navigation API path (modern browsers)", () => {
    it("calls history.back() when navigation.canGoBack is true", () => {
      const { navigate, historyBack } = setupWindow({
        navigation: { canGoBack: true },
        historyState: { idx: 0 },
      });

      useRouter().back();

      expect(historyBack).toHaveBeenCalledOnce();
      expect(navigate).not.toHaveBeenCalled();
    });

    it("falls back to / when navigation.canGoBack is false (no basename)", () => {
      const { navigate, historyBack } = setupWindow({
        navigation: { canGoBack: false },
        historyState: { idx: 5 }, // idx irrelevant when Navigation API is present
      });

      useRouter().back();

      expect(historyBack).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    });

    it("falls back to /<basename> when navigation.canGoBack is false", () => {
      const { navigate, historyBack } = setupWindow({
        basename: "/app",
        navigation: { canGoBack: false },
        historyState: null,
      });

      useRouter().back();

      expect(historyBack).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith("/app", { replace: true });
    });
  });

  describe("idx fallback (older browsers without Navigation API)", () => {
    it("calls history.back() when history.state.idx > 0", () => {
      const { navigate, historyBack } = setupWindow({
        navigation: undefined,
        historyState: { idx: 2 },
      });

      useRouter().back();

      expect(historyBack).toHaveBeenCalledOnce();
      expect(navigate).not.toHaveBeenCalled();
    });

    it("falls back to / when history.state.idx is 0 (no basename)", () => {
      const { navigate, historyBack } = setupWindow({
        navigation: undefined,
        historyState: { idx: 0 },
      });

      useRouter().back();

      expect(historyBack).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    });

    it("falls back to /<basename> when history.state.idx is 0", () => {
      const { navigate, historyBack } = setupWindow({
        basename: "/app",
        navigation: undefined,
        historyState: { idx: 0 },
      });

      useRouter().back();

      expect(historyBack).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/app", { replace: true });
    });

    it("treats missing history.state as first entry and falls back", () => {
      const { navigate, historyBack } = setupWindow({
        basename: "/app",
        navigation: undefined,
        historyState: null,
      });

      useRouter().back();

      expect(historyBack).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/app", { replace: true });
    });

    it("treats history.state without idx as first entry and falls back", () => {
      const { navigate, historyBack } = setupWindow({
        navigation: undefined,
        historyState: { someOtherField: "x" },
      });

      useRouter().back();

      expect(historyBack).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    });
  });
});
