/**
 * awaitBeforeFlush (loader(Def, { ssr: false })) in resolveLoaders.
 *
 * Document renders await flagged loaders before segment resolution returns:
 * the render barrier (and Response construction behind it) cannot happen
 * until they settle, which is what makes their data, handle pushes, and
 * thrown-notFound status deterministic in the SSR'd document. Unflagged
 * siblings keep streaming. Shell-capture renders await too — flagged loaders
 * BAKE at capture (only unflagged LIVE-lane loaders are masked), so their
 * handle pushes land in the captured HTML.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EntryData, LoaderEntry } from "../../../server/context";

const mockRequestCtx: any = { _shellCaptureRun: undefined, params: {} };

vi.mock("../../../server/request-context.js", () => ({
  getRequestContext: vi.fn(() => mockRequestCtx),
  _getRequestContext: vi.fn(() => mockRequestCtx),
  runWithRequestContext: <T>(_c: unknown, fn: () => T): T => fn(),
}));

import { resolveLoaders } from "../fresh";

function createMockLoader(id: string, promise?: Promise<unknown>) {
  const fn = vi.fn(() => promise ?? Promise.resolve({ data: id }));
  (fn as any).$$id = id;
  return fn;
}

function createMockCtx() {
  const url = new URL("https://example.com/x");
  return {
    params: {},
    pathname: "/x",
    url,
    originalUrl: url,
    request: new Request(url),
    env: {},
    use: vi.fn((loader: any) => loader()),
  } as any;
}

/** Streaming-shaped entry: renderable loading() puts loaders on the streaming path. */
function createEntry(loaderEntries: LoaderEntry[]): EntryData {
  return {
    id: "entry-1",
    shortCode: "R0",
    loader: loaderEntries,
    loading: "renderable-fallback",
  } as unknown as EntryData;
}

function loaderEntry(loader: any, awaitBeforeFlush?: true): LoaderEntry {
  return {
    loader,
    revalidate: [],
    ...(awaitBeforeFlush && { awaitBeforeFlush }),
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

const deps = { wrapLoaderPromise: (p: Promise<unknown>) => p } as never;

describe("resolveLoaders awaitBeforeFlush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestCtx._shellCaptureRun = undefined;
    mockRequestCtx._awaitBeforeFlushLoaderIds = undefined;
  });

  it("blocks segment resolution until the flagged loader settles; the unflagged sibling keeps streaming", async () => {
    let resolveFlagged!: (v: unknown) => void;
    const flaggedPromise = new Promise((r) => {
      resolveFlagged = r;
    });
    const flagged = createMockLoader("flagged#L", flaggedPromise);
    // Never resolves: proves the await is scoped per loader, not per segment.
    const sibling = createMockLoader("sibling#L", new Promise(() => {}));

    const entry = createEntry([
      loaderEntry(flagged, true),
      loaderEntry(sibling),
    ]);

    const resolution = resolveLoaders(entry, createMockCtx(), true, deps);

    // Both loaders kicked off in parallel, resolution held by the flagged one.
    expect(flagged).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(await settlesWithin(resolution, 30)).toBe(false);

    resolveFlagged({ data: "flagged" });
    const segments = await resolution;

    expect(segments).toHaveLength(2);
    expect(await settlesWithin(segments[0]!.loaderData!, 5)).toBe(true);
    expect(await settlesWithin(segments[1]!.loaderData!, 30)).toBe(false);
  });

  it("stamps awaitBeforeFlush on the flagged loader's segment only", async () => {
    const flagged = createMockLoader("flagged#L");
    const sibling = createMockLoader("sibling#L", new Promise(() => {}));
    const entry = createEntry([
      loaderEntry(flagged, true),
      loaderEntry(sibling),
    ]);

    const segments = await resolveLoaders(entry, createMockCtx(), true, deps);

    expect(segments[0]!.awaitBeforeFlush).toBe(true);
    expect(segments[1]!.awaitBeforeFlush).toBeUndefined();
  });

  it("stamps awaitBeforeFlush on the loading-disabled return for flagged loaders", async () => {
    const flagged = createMockLoader("flagged#L");
    const sibling = createMockLoader("sibling#L");
    const entry = {
      ...createEntry([loaderEntry(flagged, true), loaderEntry(sibling)]),
      loading: false,
    };

    const segments = await resolveLoaders(entry, createMockCtx(), true, deps);

    expect(segments[0]!.awaitBeforeFlush).toBe(true);
    expect(segments[1]!.awaitBeforeFlush).toBeUndefined();
    expect([...mockRequestCtx._awaitBeforeFlushLoaderIds]).toEqual([
      "flagged#L",
    ]);
  });

  it("capture: stamps awaitBeforeFlush too (segment-system value delivery + diagnostics key off it)", async () => {
    mockRequestCtx._shellCaptureRun = true;
    mockRequestCtx._shellCaptureLoaderRecords = new Map();
    const flagged = createMockLoader("flagged#L");
    const entry = createEntry([loaderEntry(flagged, true)]);

    const segments = await resolveLoaders(entry, createMockCtx(), true, deps);

    expect(segments[0]!.awaitBeforeFlush).toBe(true);
  });

  it("registers the flagged loader id for the rendered() cycle guard before kickoff", async () => {
    const flagged = createMockLoader("flagged#L");
    const entry = createEntry([loaderEntry(flagged, true)]);

    await resolveLoaders(entry, createMockCtx(), true, deps);

    expect([...mockRequestCtx._awaitBeforeFlushLoaderIds]).toEqual([
      "flagged#L",
    ]);
  });

  it("returns immediately when no loader is flagged", async () => {
    const pending = createMockLoader("pending#L", new Promise(() => {}));
    const entry = createEntry([loaderEntry(pending)]);

    const resolution = resolveLoaders(entry, createMockCtx(), true, deps);

    expect(await settlesWithin(resolution, 30)).toBe(true);
    const segments = await resolution;
    expect(await settlesWithin(segments[0]!.loaderData!, 30)).toBe(false);
    expect(mockRequestCtx._awaitBeforeFlushLoaderIds).toBeUndefined();
  });

  it("capture: flagged loader BAKES and resolution awaits the bake; unflagged stays masked", async () => {
    mockRequestCtx._shellCaptureRun = true;
    mockRequestCtx._shellCaptureLoaderRecords = new Map();
    // Flagged: executes at capture (bake lane) and resolution HOLDS on it
    // so bake-lane handle pushes beat the capture barrier. Unflagged
    // sibling is masked and never runs.
    let resolveFlagged!: (v: unknown) => void;
    const flagged = createMockLoader(
      "flagged#L",
      new Promise((r) => {
        resolveFlagged = r;
      }),
    );
    const plain = createMockLoader("plain#L", new Promise(() => {}));
    const entry = createEntry([loaderEntry(flagged, true), loaderEntry(plain)]);

    const resolution = resolveLoaders(entry, createMockCtx(), true, deps);

    expect(flagged).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
    expect(await settlesWithin(resolution, 30)).toBe(false);

    resolveFlagged({ data: "flagged" });
    const segments = await resolution;
    expect(segments).toHaveLength(2);
    // The masked-container record registered under the loader's segment key —
    // this is what holds the capture gate and pins the shell snapshot.
    expect([...mockRequestCtx._shellCaptureLoaderRecords.keys()]).toEqual([
      "R0D0.flagged#L",
    ]);
    // The rendered() cycle guard registers during capture too: the await
    // creates the same cycle a live document render has.
    expect([...mockRequestCtx._awaitBeforeFlushLoaderIds]).toEqual([
      "flagged#L",
    ]);
  });
});
