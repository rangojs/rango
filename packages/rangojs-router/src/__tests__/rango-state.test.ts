import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A minimal document.cookie jar: stores name->value, ignores attributes.
// Our values are token-safe (version is percent-encoded), so a single `=`
// split is sufficient.
function makeJar(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  const jar = {
    get cookie(): string {
      return Object.entries(store)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    },
    set cookie(str: string) {
      const segment = str.split(";")[0];
      const eq = segment.indexOf("=");
      if (eq < 0) return;
      store[segment.slice(0, eq).trim()] = segment.slice(eq + 1);
    },
  };
  return {
    jar,
    set: (k: string, v: string) => {
      store[k] = v;
    },
    del: (k: string) => {
      delete store[k];
    },
    store,
  };
}

function makeLocalStorage(data: Record<string, string>) {
  return {
    get length() {
      return Object.keys(data).length;
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
  };
}

const NAME = "rango-state_router_0";

describe("rango-state (cookie)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("location", { protocol: "http:" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps an existing matching-version cookie and does not mint", async () => {
    const j = makeJar({ [NAME]: "v1:123" });
    vi.stubGlobal("document", j.jar);

    const { initRangoState, getRangoState } =
      await import("../browser/rango-state");
    initRangoState("v1", NAME);

    expect(j.store[NAME]).toBe("v1:123");
    expect(getRangoState()).toBe("v1:123");
  });

  it("mints a fresh value when the version changes (deploy bust)", async () => {
    const j = makeJar({ [NAME]: "v1:111" });
    vi.stubGlobal("document", j.jar);
    vi.spyOn(Date, "now").mockReturnValue(222);

    const { initRangoState, getRangoState } =
      await import("../browser/rango-state");
    initRangoState("v2", NAME);

    expect(j.store[NAME]).toBe("v2:222");
    expect(getRangoState()).toBe("v2:222");
  });

  it("mints and writes a cookie when none exists", async () => {
    const j = makeJar();
    vi.stubGlobal("document", j.jar);
    vi.spyOn(Date, "now").mockReturnValue(500);

    const { initRangoState, getRangoState } =
      await import("../browser/rango-state");
    initRangoState("v1", NAME);

    expect(j.store[NAME]).toBe("v1:500");
    expect(getRangoState()).toBe("v1:500");
  });

  it("falls back to the bare default prefix when no name is supplied", async () => {
    const j = makeJar({ "rango-state": "v1:9" });
    vi.stubGlobal("document", j.jar);

    const { initRangoState, getRangoState } =
      await import("../browser/rango-state");
    initRangoState("v1");

    expect(getRangoState()).toBe("v1:9");
  });

  it("rotates the timestamp and preserves the version on self-invalidation", async () => {
    const j = makeJar({ [NAME]: "v7:100" });
    vi.stubGlobal("document", j.jar);
    vi.spyOn(Date, "now").mockReturnValue(999);

    const { initRangoState, invalidateRangoState, getRangoState } =
      await import("../browser/rango-state");
    initRangoState("v7", NAME);
    invalidateRangoState();

    expect(j.store[NAME]).toBe("v7:999");
    expect(getRangoState()).toBe("v7:999");
  });

  it("never produces a no-op rotation within the same millisecond (monotonic guard)", async () => {
    const j = makeJar();
    vi.stubGlobal("document", j.jar);
    vi.spyOn(Date, "now").mockReturnValue(500); // clock frozen

    const { initRangoState, invalidateRangoState, getRangoState } =
      await import("../browser/rango-state");
    initRangoState("v1", NAME); // v1:500
    invalidateRangoState(); // would be a no-op without the guard
    expect(getRangoState()).toBe("v1:501");
    invalidateRangoState();
    expect(getRangoState()).toBe("v1:502");
  });

  it("uses the in-memory mirror when the cookie is unreadable", async () => {
    const throwingDoc = {
      get cookie(): string {
        throw new Error("blocked");
      },
      set cookie(_v: string) {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("document", throwingDoc);
    vi.spyOn(Date, "now").mockReturnValue(700);

    const { initRangoState, getRangoState, invalidateRangoState } =
      await import("../browser/rango-state");
    initRangoState("v1", NAME);

    // No cookie was readable/writable, but the value is stable in memory.
    expect(getRangoState()).toBe("v1:700");
    invalidateRangoState();
    expect(getRangoState()).toBe("v1:701");
  });

  it("deletes legacy localStorage keys on boot (no value porting)", async () => {
    const data = {
      "rango-state": "old",
      "rango-state:router_0": "old2",
      "unrelated-key": "keep",
    };
    const j = makeJar({ [NAME]: "v1:1" });
    vi.stubGlobal("document", j.jar);
    vi.stubGlobal("localStorage", makeLocalStorage(data));

    const { initRangoState } = await import("../browser/rango-state");
    initRangoState("v1", NAME);

    expect(data["rango-state"]).toBeUndefined();
    expect(data["rango-state:router_0"]).toBeUndefined();
    expect(data["unrelated-key"]).toBe("keep");
  });

  describe("external-rotation observer", () => {
    it("fires once when a read adopts an externally-changed cookie", async () => {
      const j = makeJar({ [NAME]: "v1:100" });
      vi.stubGlobal("document", j.jar);

      const { initRangoState, getRangoState, setRangoStateObserver } =
        await import("../browser/rango-state");
      initRangoState("v1", NAME);

      const observer = vi.fn();
      setRangoStateObserver(observer);

      // A sibling tab rotated the shared cookie.
      j.set(NAME, "v1:200");
      expect(getRangoState()).toBe("v1:200");
      // Subsequent reads in the same burst see the mirror and stay silent.
      expect(getRangoState()).toBe("v1:200");
      expect(getRangoState()).toBe("v1:200");

      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith("v1:200");
    });

    it("does not fire on a self-rotation", async () => {
      const j = makeJar({ [NAME]: "v1:100" });
      vi.stubGlobal("document", j.jar);

      const {
        initRangoState,
        invalidateRangoState,
        getRangoState,
        setRangoStateObserver,
      } = await import("../browser/rango-state");
      initRangoState("v1", NAME);

      const observer = vi.fn();
      setRangoStateObserver(observer);

      invalidateRangoState();
      getRangoState();
      getRangoState();

      expect(observer).not.toHaveBeenCalled();
    });

    it("mints and fires once when the cookie is externally cleared", async () => {
      const j = makeJar({ [NAME]: "v1:100" });
      vi.stubGlobal("document", j.jar);
      vi.spyOn(Date, "now").mockReturnValue(900);

      const { initRangoState, getRangoState, setRangoStateObserver } =
        await import("../browser/rango-state");
      initRangoState("v1", NAME);

      const observer = vi.fn();
      setRangoStateObserver(observer);

      j.del(NAME); // cookies cleared
      expect(getRangoState()).toBe("v1:900"); // minted (max(900, 100+1))
      // Cookie was rewritten; next read matches the mirror, no re-fire.
      expect(getRangoState()).toBe("v1:900");

      expect(observer).toHaveBeenCalledTimes(1);
    });

    it("ignores a different app's cookie name (multi-app isolation)", async () => {
      const j = makeJar({ [NAME]: "v1:100" });
      vi.stubGlobal("document", j.jar);

      const { initRangoState, getRangoState, setRangoStateObserver } =
        await import("../browser/rango-state");
      initRangoState("v1", NAME);

      const observer = vi.fn();
      setRangoStateObserver(observer);

      // A sibling app rotates ITS cookie; ours is untouched.
      j.set("rango-state_router_1", "v1:777");
      expect(getRangoState()).toBe("v1:100");

      expect(observer).not.toHaveBeenCalled();
    });
  });
});
