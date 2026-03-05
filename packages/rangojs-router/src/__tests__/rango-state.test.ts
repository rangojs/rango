import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

function restoreGlobal(
  key: "window" | "localStorage",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>)[key];
}

describe("rango-state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreGlobal("window", originalWindowDescriptor);
    restoreGlobal("localStorage", originalLocalStorageDescriptor);
  });

  it("keeps existing state when version matches", async () => {
    const listeners: Array<(e: StorageEvent) => void> = [];
    const storage = {
      getItem: vi.fn(() => "v1:123"),
      setItem: vi.fn(),
    };

    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, cb: (e: StorageEvent) => void) => {
        if (type === "storage") listeners.push(cb);
      }),
    });
    vi.stubGlobal("localStorage", storage);

    const { initRangoState, getRangoState } =
      await import("../browser/rango-state");

    initRangoState("v1");

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(getRangoState()).toBe("v1:123");
    expect(listeners).toHaveLength(1);
  });

  it("writes new state when version changes", async () => {
    const storageData: Record<string, string> = { "rango-state": "v1:111" };
    const storage = {
      getItem: vi.fn((key: string) => storageData[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storageData[key] = value;
      }),
    };

    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("localStorage", storage);
    vi.spyOn(Date, "now").mockReturnValue(222);

    const { initRangoState, getRangoState } =
      await import("../browser/rango-state");

    initRangoState("v2");

    expect(storage.setItem).toHaveBeenCalledWith("rango-state", "v2:222");
    expect(getRangoState()).toBe("v2:222");
  });

  it("invalidates by rotating timestamp and preserving version", async () => {
    const storageData: Record<string, string> = { "rango-state": "v7:100" };
    const storage = {
      getItem: vi.fn((key: string) => storageData[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storageData[key] = value;
      }),
    };

    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("localStorage", storage);
    vi.spyOn(Date, "now").mockReturnValue(999);

    const { invalidateRangoState, getRangoState } =
      await import("../browser/rango-state");

    invalidateRangoState();

    expect(storage.setItem).toHaveBeenCalledWith("rango-state", "v7:999");
    expect(getRangoState()).toBe("v7:999");
  });

  it("updates cached state from storage events", async () => {
    const listeners: Array<(e: StorageEvent) => void> = [];
    const storage = {
      getItem: vi.fn(() => "v1:1"),
      setItem: vi.fn(),
    };

    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, cb: (e: StorageEvent) => void) => {
        if (type === "storage") listeners.push(cb);
      }),
    });
    vi.stubGlobal("localStorage", storage);

    const { initRangoState, getRangoState } =
      await import("../browser/rango-state");

    initRangoState("v1");
    listeners[0]({ key: "rango-state", newValue: "v1:500" } as StorageEvent);

    expect(getRangoState()).toBe("v1:500");
  });
});
