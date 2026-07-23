import { describe, it, expect, vi, beforeEach } from "vitest";

// The deserializer chain needs the Flight runtime — stub it; the latch under
// test only cares that the encoded payload reaches it.
vi.mock("../../../cache/segment-codec.js", () => ({
  deserializeComponent: vi.fn(async (encoded: string) => `NODE:${encoded}`),
}));
vi.mock("../../../cache/handle-snapshot.js", () => ({
  decodeHandleValue: vi.fn(),
}));

// _staticStore is module-level state; a fresh module per test isolates the
// latch transitions (undefined -> null / undefined -> store).
async function freshTryStaticLookup() {
  vi.resetModules();
  const mod = await import("../static-store.js");
  return mod.tryStaticLookup;
}

describe("static-store lazy manifest latch (issue #760)", () => {
  beforeEach(() => {
    delete (globalThis as any).__STATIC_MANIFEST;
    delete (globalThis as any).__loadStaticManifestModule;
  });

  it("latches null on the FIRST call without awaiting when no manifest exists", async () => {
    const tryStaticLookup = await freshTryStaticLookup();
    // The no-manifest fast path must stay synchronous (workerd ALS scar):
    // the returned promise resolves undefined without the loader machinery.
    await expect(tryStaticLookup("h1", "R0")).resolves.toBeUndefined();
    // Loader arriving AFTER the latch is ignored — null is permanent.
    (globalThis as any).__loadStaticManifestModule = vi.fn();
    await expect(tryStaticLookup("h1", "R0")).resolves.toBeUndefined();
    expect(
      (globalThis as any).__loadStaticManifestModule,
    ).not.toHaveBeenCalled();
  });

  it("resolves the deferred manifest module once on first lookup", async () => {
    const tryStaticLookup = await freshTryStaticLookup();
    const loader = vi.fn(async () => {
      (globalThis as any).__STATIC_MANIFEST = {
        h1: async () => ({ default: "ENC" }),
      };
    });
    (globalThis as any).__loadStaticManifestModule = loader;

    await expect(tryStaticLookup("h1", "R0")).resolves.toBe("NODE:ENC");
    await expect(tryStaticLookup("h1", "R0")).resolves.toBe("NODE:ENC");
    expect(loader).toHaveBeenCalledTimes(1);
    // Unknown handler falls through to undefined via the real store.
    await expect(tryStaticLookup("missing", "R0")).resolves.toBeUndefined();
  });

  it("supports a pre-set __STATIC_MANIFEST without a loader thunk", async () => {
    const tryStaticLookup = await freshTryStaticLookup();
    (globalThis as any).__STATIC_MANIFEST = {
      h2: async () => ({ default: "PRE" }),
    };
    await expect(tryStaticLookup("h2", "R0")).resolves.toBe("NODE:PRE");
  });
});
