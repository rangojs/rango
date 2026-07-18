import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EntryData, LoaderEntry } from "../../../server/context";

// PPR shell capture masks route loaders: during a capture render loader
// functions must NOT execute, and their slots must hold a never-resolving promise
// so the consuming Suspense subtree postpones. See loader-mask.ts and
// docs/design/ppr-shell-resume.md. The ACTIVE capture is read off
// requestCtx._shellCaptureRun (only the background derived context sets it — the
// foreground descriptor _shellCapture must NOT trigger masking).

const mockRequestCtx: any = { _shellCaptureRun: undefined, params: {} };

vi.mock("../../../server/request-context.js", () => ({
  getRequestContext: vi.fn(() => mockRequestCtx),
  _getRequestContext: vi.fn(() => mockRequestCtx),
  runWithRequestContext: <T>(_c: unknown, fn: () => T): T => fn(),
}));

import { resolveLoaderData } from "../loader-cache";
import { resolveLoadersWithRevalidation } from "../revalidation";
import {
  isShellCaptureActive,
  createMaskedLoaderPromise,
} from "../loader-mask";

function createMockLoader(id: string) {
  const fn = vi.fn(async () => ({ data: "real" }));
  (fn as any).$$id = id;
  return fn;
}

function createMockCtx() {
  return {
    params: {},
    pathname: "/x",
    use: vi.fn((loader: any) => loader()),
  } as any;
}

function createLoaderEntry(loader: any, cacheOptions?: any): LoaderEntry {
  return {
    loader,
    revalidate: [],
    cache: cacheOptions !== undefined ? { options: cacheOptions } : undefined,
  } as LoaderEntry;
}

/** True iff the promise settles (resolve or reject) within `ms`. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

function createEntry(loader: any, loading?: unknown): EntryData {
  return {
    id: "entry-1",
    shortCode: "R0",
    loader: [{ loader, revalidate: [] } as LoaderEntry],
    ...(loading !== undefined && { loading }),
  } as EntryData;
}

function runRevalidationFunnel(entry: EntryData, ctx: any) {
  const url = new URL("https://example.com/x");
  return resolveLoadersWithRevalidation(
    entry,
    ctx,
    true,
    // Client has never seen the segment, so shouldRun is true without invoking
    // evaluateRevalidation.
    new Set<string>(),
    {},
    new Request(url),
    url,
    url,
    "route-key",
    { wrapLoaderPromise: (promise: Promise<unknown>) => promise } as never,
  );
}

describe("loader masking under PPR shell capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestCtx._shellCaptureRun = undefined;
  });

  describe("isShellCaptureActive", () => {
    it("is false when _shellCaptureRun is unset", () => {
      expect(isShellCaptureActive()).toBe(false);
    });

    it("is false when only the _shellCapture DESCRIPTOR is set (foreground)", () => {
      // The descriptor means "a capture is wanted" and must NOT mask loaders on
      // the foreground render — only the background run's _shellCaptureRun does.
      mockRequestCtx._shellCapture = { key: "k:shell" };
      expect(isShellCaptureActive()).toBe(false);
      mockRequestCtx._shellCapture = undefined;
    });

    it("is true when _shellCaptureRun is set (active background capture)", () => {
      mockRequestCtx._shellCaptureRun = true;
      expect(isShellCaptureActive()).toBe(true);
    });
  });

  describe("createMaskedLoaderPromise", () => {
    it("returns a promise that never settles", async () => {
      expect(await settlesWithin(createMaskedLoaderPromise(), 30)).toBe(false);
    });
  });

  describe("resolveLoaderData gate", () => {
    it("does NOT invoke the loader and returns a never-resolving promise in capture mode (no cache config)", async () => {
      mockRequestCtx._shellCaptureRun = true;
      const loader = createMockLoader("l1");
      const ctx = createMockCtx();

      const p = resolveLoaderData(createLoaderEntry(loader), ctx, "/x");

      expect(await settlesWithin(p, 30)).toBe(false);
      expect(ctx.use).not.toHaveBeenCalled();
      expect(loader).not.toHaveBeenCalled();
    });

    it("does NOT invoke the loader or touch the cache store in capture mode (cached loader)", async () => {
      mockRequestCtx._shellCaptureRun = true;
      const loader = createMockLoader("l2");
      const store: any = {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => {}),
      };
      const ctx = createMockCtx();

      // The gate is the FIRST statement of resolveLoaderData, before any cache
      // machinery — so no getItem/setItem round-trip happens during capture.
      const p = resolveLoaderData(
        createLoaderEntry(loader, { store, ttl: 60 }),
        ctx,
        "/x",
      );

      expect(await settlesWithin(p, 30)).toBe(false);
      expect(ctx.use).not.toHaveBeenCalled();
      expect(loader).not.toHaveBeenCalled();
      expect(store.getItem).not.toHaveBeenCalled();
      expect(store.setItem).not.toHaveBeenCalled();
    });

    it("invokes the loader normally when capture is NOT active (no-op gate)", async () => {
      const loader = createMockLoader("l3");
      const ctx = createMockCtx();

      const result = await resolveLoaderData(
        createLoaderEntry(loader),
        ctx,
        "/x",
      );

      expect(ctx.use).toHaveBeenCalledWith(loader);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ data: "real" });
    });
  });
});

describe("revalidation loader lanes under PPR shell capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestCtx._shellCaptureRun = undefined;
  });

  it("executes a BAKE-lane loader instead of whole-container masking", async () => {
    mockRequestCtx._shellCaptureRun = true;
    const loader = createMockLoader("bake#L");
    const ctx = createMockCtx();

    const { segments } = await runRevalidationFunnel(createEntry(loader), ctx);

    expect(segments).toHaveLength(1);
    expect(await settlesWithin(segments[0].loaderData!, 30)).toBe(true);
    expect(ctx.use).toHaveBeenCalledWith(loader);
    expect(loader).toHaveBeenCalledTimes(1);
    await expect(segments[0].loaderData).resolves.toEqual({ data: "real" });
  });

  it("still whole-container-masks a LIVE-lane loader", async () => {
    mockRequestCtx._shellCaptureRun = true;
    const loader = createMockLoader("live#L");
    const ctx = createMockCtx();

    const { segments } = await runRevalidationFunnel(
      createEntry(loader, "renderable-fallback"),
      ctx,
    );

    expect(segments).toHaveLength(1);
    expect(await settlesWithin(segments[0].loaderData!, 30)).toBe(false);
    expect(ctx.use).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });

  it("executes normally outside capture", async () => {
    const loader = createMockLoader("plain#L");

    const { segments } = await runRevalidationFunnel(
      createEntry(loader),
      createMockCtx(),
    );

    expect(segments).toHaveLength(1);
    await expect(segments[0].loaderData).resolves.toEqual({ data: "real" });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
