import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderEntry } from "../../../server/context";

// Shell-HIT tail seed overlay (loader-cache.ts): a bake-lane loader whose
// container was pinned in the shell snapshot resolves from the pin. The
// capture-computed hole bit picks the path:
//   - holes: false (fully pinned) -> PIN-FIRST: the payload promise resolves
//     immediately from the pin; the fresh run still executes (side effects,
//     cache read-through) but never gates the stream, and its rejection is
//     swallowed (the payload already matches the prelude).
//   - holes: true  -> gated: the overlay waits for the fresh run, which mints
//     the live nested promises the hole markers re-slot.
// See loader-snapshot.ts and docs/design/ppr-shell-resume.md.

const mockRequestCtx: any = {
  _shellCaptureRun: undefined,
  _shellLoaderSeed: undefined,
  executionContext: undefined,
  params: {},
};

vi.mock("../../../server/request-context.js", () => ({
  getRequestContext: vi.fn(() => mockRequestCtx),
  _getRequestContext: vi.fn(() => mockRequestCtx),
  runWithRequestContext: <T>(_c: unknown, fn: () => T): T => fn(),
}));

import { resolveLoaderData } from "../loader-cache";
import { LOADER_HOLE_KEY } from "../loader-snapshot";

const SEGMENT_KEY = "R0D0.app/x#Loader";

function createLoaderEntry(loader: any): LoaderEntry {
  return { loader, revalidate: [] } as unknown as LoaderEntry;
}

function createMockCtx() {
  return {
    params: {},
    use: vi.fn((loader: any) => loader()),
  } as any;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("shell-HIT seed overlay lanes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestCtx._shellCaptureRun = undefined;
    mockRequestCtx._shellLoaderSeed = undefined;
    mockRequestCtx.executionContext = undefined;
  });

  it("pin-first (holes: false): resolves the pin immediately, fresh run ungated but still executed", async () => {
    const loader = vi.fn(async () => {
      await sleep(50);
      return { price: "fresh-1" };
    });
    (loader as any).$$id = "L";
    mockRequestCtx._shellLoaderSeed = new Map([
      [SEGMENT_KEY, { container: { price: "pinned" }, holes: false }],
    ]);
    const waitUntil = vi.fn();
    mockRequestCtx.executionContext = { waitUntil };

    const result = resolveLoaderData(
      createLoaderEntry(loader),
      createMockCtx(),
      "/x",
      SEGMENT_KEY,
    );

    // The payload promise must NOT wait for the 50ms fresh run.
    expect(await settlesWithin(result, 15)).toBe(true);
    expect(await result).toEqual({ price: "pinned" });
    // Side effects preserved: the fresh loader body DID start, and its
    // promise was lifetime-extended so the runtime cannot cancel it.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("pin-first: a fresh-run rejection is swallowed and the pin still serves", async () => {
    const loader = vi.fn(async () => {
      throw new Error("fresh boom");
    });
    (loader as any).$$id = "L";
    mockRequestCtx._shellLoaderSeed = new Map([
      [SEGMENT_KEY, { container: { price: "pinned" }, holes: false }],
    ]);

    const result = resolveLoaderData(
      createLoaderEntry(loader),
      createMockCtx(),
      "/x",
      SEGMENT_KEY,
    );

    await expect(result).resolves.toEqual({ price: "pinned" });
    // Give the swallowed rejection a tick; an unhandled rejection here would
    // fail the test run.
    await sleep(5);
  });

  it("pin-first CONTRACT: fresh-only keys are dropped — the pinned shape serves wholesale", async () => {
    // Deliberate divergence from the gated overlay's fresh-only passthrough
    // (loader-snapshot.test.ts "fresh-only keys pass through"): for a
    // hole-free record, a key added by the fresh run mid-TTL never had a
    // postponed hole, so the prelude froze the without-that-field branch and
    // the resume pass has nothing to fill — passthrough only produced a
    // hydration mismatch the client had to repair. Pin-first serves the
    // pinned shape; a per-request field must be promise-shaped at capture
    // (-> holes: 1 -> gated path, where passthrough still holds) or live
    // behind loading().
    const loader = vi.fn(async () => ({
      stable: "fresh-new",
      added: Promise.resolve("appeared-at-hit"),
    }));
    (loader as any).$$id = "L";
    mockRequestCtx._shellLoaderSeed = new Map([
      [SEGMENT_KEY, { container: { stable: "pinned" }, holes: false }],
    ]);

    const result = await resolveLoaderData(
      createLoaderEntry(loader),
      createMockCtx(),
      "/x",
      SEGMENT_KEY,
    );

    expect(result).toEqual({ stable: "pinned" });
    expect("added" in (result as Record<string, unknown>)).toBe(false);
  });

  it("gated (holes: true): fresh-only keys still pass through (the passthrough contract is gated-path only)", async () => {
    const loader = vi.fn(async () => ({
      stable: "fresh-new",
      added: "appeared-at-hit",
      live: "live-value",
    }));
    (loader as any).$$id = "L";
    mockRequestCtx._shellLoaderSeed = new Map([
      [
        SEGMENT_KEY,
        {
          container: { stable: "pinned", live: { [LOADER_HOLE_KEY]: 1 } },
          holes: true,
        },
      ],
    ]);

    const result = await resolveLoaderData(
      createLoaderEntry(loader),
      createMockCtx(),
      "/x",
      SEGMENT_KEY,
    );

    expect(result).toEqual({
      stable: "pinned",
      live: "live-value",
      added: "appeared-at-hit",
    });
  });

  it("gated (holes: true): waits for the fresh run and re-slots the live value at the hole", async () => {
    const loader = vi.fn(async () => {
      await sleep(30);
      return { price: "pinned-path-fresh", live: "live-value" };
    });
    (loader as any).$$id = "L";
    mockRequestCtx._shellLoaderSeed = new Map([
      [
        SEGMENT_KEY,
        {
          container: { price: "pinned", live: { [LOADER_HOLE_KEY]: 1 } },
          holes: true,
        },
      ],
    ]);

    const result = resolveLoaderData(
      createLoaderEntry(loader),
      createMockCtx(),
      "/x",
      SEGMENT_KEY,
    );

    // Gated on the 30ms fresh run — must NOT settle early.
    expect(await settlesWithin(result, 10)).toBe(false);
    // Recorded path wins, hole path takes the fresh (live) value.
    expect(await result).toEqual({ price: "pinned", live: "live-value" });
  });

  it("no seed entry for the key: plain fresh execution", async () => {
    const loader = vi.fn(async () => ({ price: "fresh" }));
    (loader as any).$$id = "L";
    mockRequestCtx._shellLoaderSeed = new Map([
      ["OTHER_KEY", { container: { price: "pinned" }, holes: false }],
    ]);

    const result = await resolveLoaderData(
      createLoaderEntry(loader),
      createMockCtx(),
      "/x",
      SEGMENT_KEY,
    );

    expect(result).toEqual({ price: "fresh" });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
