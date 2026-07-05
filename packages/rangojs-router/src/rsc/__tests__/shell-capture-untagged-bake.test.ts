import { describe, it, expect, vi } from "vitest";
import { captureAndStoreShell } from "../shell-capture.js";
import { createHandleStore } from "../../server/handle-store.js";
import type { SSRModule } from "../types.js";

// Part A (plan 008): a bake-lane loader that freezes UNTAGGED mutable data into
// the shared shell is un-invalidatable except by TTL — an action refresh skips
// the server shell store, and updateTag()/revalidateTag() cannot drop data baked
// without a tag. captureAndStoreShell now emits a DEV-only, once-per-shell-key
// console.warn for that shape. These pin the coarse per-shell-key signal:
//   untagged bake + no ppr.tags  -> warn ONCE
//   tagged (_requestTags) OR ppr.tags (descriptor.tags) -> no warn
//   hole-only loader (no real bake) -> no warn
//   production (NODE_ENV=production) -> no warn (dev-only)
//
// The warning fires off `bakedLoaderMaterial` (a container that settled with
// real, non-hole material), set BEFORE the snapshot serialization the unit
// config cannot run (@vitejs/plugin-rsc/rsc is unmocked here). Serialization
// failing is swallowed, but the data is already frozen in the prelude — so the
// diagnostic still fires, which is the contract.

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** A closed Flight stream stand-in (captureAndStoreShell ignores its bytes). */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
}

/** A putShell spy typed to the store family signature. */
function makePutShell() {
  return vi.fn(
    async (
      _key: string,
      _entry: {
        prelude: string;
        postponed: string | null;
        reactVersion: string;
        initialTheme?: string;
        createdAt: number;
      },
      _ttl?: number,
      _swr?: number,
      _tags?: string[],
    ) => {},
  );
}

function makeShellSsrModule(): SSRModule {
  return {
    renderHTML: vi.fn(),
    captureShellHTML: vi.fn(async () => ({
      prelude: enc("<html><body>shell</body></html>"),
      postponed: null,
    })),
  } as unknown as SSRModule;
}

/**
 * Minimal foreground RequestContext stub, matching shell-capture.test.ts's
 * direct-call stub: putShell store, background-error reporter, and the fresh
 * _requestTags the write barrier snapshots (issue #676).
 */
function makeReqCtx(
  putShell: ReturnType<typeof makePutShell>,
  opts: {
    loaderRecords?: Map<string, Promise<unknown>>;
    requestTags?: Set<string>;
  } = {},
): any {
  return {
    _cacheStore: { putShell },
    _reportBackgroundError: vi.fn(),
    _requestTags: opts.requestTags ?? new Set<string>(),
    _shellCaptureLoaderRecords: opts.loaderRecords,
  };
}

/** A bake-lane record that settles with real (non-hole) material. */
function bakedRecord(): Map<string, Promise<unknown>> {
  return new Map([["M0D0.app/x#L", Promise.resolve({ data: 1 })]]);
}

async function runCapture(
  reqCtx: any,
  descriptor: { key: string; ttl?: number; tags?: string[] },
): Promise<unknown> {
  return captureAndStoreShell(
    makeShellSsrModule(),
    emptyStream(),
    createHandleStore(),
    reqCtx,
    { ...descriptor, store: reqCtx._cacheStore },
  );
}

describe("captureAndStoreShell — untagged shell-bake diagnostic (plan 008 Part A)", () => {
  it("warns ONCE per shell key when a bake-lane loader bakes untagged data (no ppr.tags)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const key = "/untagged-bake:shell";
      const putShell = makePutShell();

      // First capture: untagged bake -> warn fires.
      const outcome = await runCapture(
        makeReqCtx(putShell, { loaderRecords: bakedRecord() }),
        { key, ttl: 300 },
      );
      expect(outcome).toBe("stored");
      expect(putShell).toHaveBeenCalledTimes(1);
      // No tags reached the store (the whole point: the baked data is untagged).
      expect(putShell.mock.calls[0]![4]).toBeUndefined();

      // Second capture, SAME key: the warning is deduped (once per key).
      await runCapture(
        makeReqCtx(makePutShell(), { loaderRecords: bakedRecord() }),
        {
          key,
          ttl: 300,
        },
      );

      const keyWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes(key),
      );
      expect(keyWarnings).toHaveLength(1);
      // The message points at BOTH fixes and the invalidation gap.
      expect(keyWarnings[0][0]).toContain("NO cache tag");
      expect(keyWarnings[0][0]).toContain("cacheTag()");
      expect(keyWarnings[0][0]).toContain("loading()");
      expect(keyWarnings[0][0]).toContain("cannot evict");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT warn when the baked loader recorded a tag (_requestTags non-empty)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const key = "/tagged-bake:shell";
      const putShell = makePutShell();

      await runCapture(
        makeReqCtx(putShell, {
          loaderRecords: bakedRecord(),
          requestTags: new Set(["products"]),
        }),
        { key, ttl: 300 },
      );

      expect(putShell).toHaveBeenCalledTimes(1);
      expect(new Set(putShell.mock.calls[0]![4])).toEqual(
        new Set(["products"]),
      );
      const keyWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes(key),
      );
      expect(keyWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT warn when static ppr.tags (descriptor.tags) tag the shell", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const key = "/ppr-tagged-bake:shell";
      const putShell = makePutShell();

      await runCapture(makeReqCtx(putShell, { loaderRecords: bakedRecord() }), {
        key,
        ttl: 300,
        tags: ["ppr:static"],
      });

      expect(putShell).toHaveBeenCalledTimes(1);
      expect(new Set(putShell.mock.calls[0]![4])).toEqual(
        new Set(["ppr:static"]),
      );
      const keyWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes(key),
      );
      expect(keyWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT warn for a hole-only (still-pending) loader — nothing real baked", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const key = "/hole-only-bake:shell";
      const putShell = makePutShell();
      // A pending container is a hole (under an ancestor boundary): it never
      // pins material into the shell, so the untagged-bake signal must not fire.
      const loaderRecords = new Map<string, Promise<unknown>>([
        ["M0D0.app/x#L", new Promise(() => {})],
      ]);

      const outcome = await runCapture(
        makeReqCtx(putShell, { loaderRecords }),
        {
          key,
          ttl: 300,
        },
      );

      expect(outcome).toBe("stored");
      const keyWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes(key),
      );
      expect(keyWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT warn in production (dev-only diagnostic)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const key = "/prod-untagged-bake:shell";
      const putShell = makePutShell();

      await runCapture(makeReqCtx(putShell, { loaderRecords: bakedRecord() }), {
        key,
        ttl: 300,
      });

      const keyWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes(key),
      );
      expect(keyWarnings).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = original;
      warnSpy.mockRestore();
    }
  });
});
