/**
 * awaitBeforeFlush (loader(Def, { ssr: false })) in a FRESH pass's loader
 * funnel (revalidation.ts resolveOwnerLoaders).
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
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EntryData, LoaderEntry } from "../../../server/context";
import type { LoaderDataResult } from "../../../types";

const mockRequestCtx: any = {
  _shellCaptureState: undefined,
  params: {},
  _setStatus: vi.fn(),
};

vi.mock("../../../server/request-context.js", () => ({
  getRequestContext: vi.fn(() => mockRequestCtx),
  _getRequestContext: vi.fn(() => mockRequestCtx),
  runWithRequestContext: <T>(_c: unknown, fn: () => T): T => fn(),
}));

import { ownerOf, resolveOwnerLoaders } from "../revalidation.js";
import { makeFreshPass } from "../../../__tests__/kit/resolution-pass.js";
import { wrapLoaderWithErrorHandling } from "../../loader-resolution";
import { redirect } from "../../../route-definition/redirect";

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

/** A document evaluation's entry: loader(Def, { ssr: false }) stamps both. */
function loaderEntry(loader: any, awaitBeforeFlush?: true): LoaderEntry {
  return {
    loader,
    revalidate: [],
    ...(awaitBeforeFlush && { awaitBeforeFlush, bake: true }),
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

/** A full match's loader funnel: a FRESH pass of resolveOwnerLoaders. */
async function resolveLoaders(
  entry: EntryData,
  ctx: any,
  belongsToRoute: boolean,
  segmentDeps: never,
) {
  const { segments } = await resolveOwnerLoaders(
    makeFreshPass(ctx, segmentDeps),
    ownerOf(entry),
    belongsToRoute,
  );
  return segments;
}

/**
 * resolveLoaders over the router's own loader lane
 * (wrapLoaderWithErrorHandling): `declared` is the nearest errorBoundary()
 * (or defaultErrorBoundary option), null when the chain has none.
 */
function laneDeps(
  declared: ReactNode | null = null,
  onError?: (error: unknown, ctx: { handledByBoundary: boolean }) => void,
): never {
  return {
    wrapLoaderPromise: (
      promise: Promise<unknown>,
      entry: EntryData,
      segmentId: string,
      pathname: string,
      _errorContext: unknown,
      useDefaultErrorBoundary?: boolean,
    ) =>
      wrapLoaderWithErrorHandling(
        promise,
        entry,
        segmentId,
        pathname,
        () => declared,
        (error, id) =>
          ({
            message: (error as Error).message,
            name: (error as Error).name,
            segmentId: id,
            segmentType: "loader",
          }) as never,
        onError,
        undefined,
        useDefaultErrorBoundary,
      ),
  } as never;
}

async function settledResult(segment: {
  loaderData?: unknown;
}): Promise<LoaderDataResult> {
  const result = (await segment.loaderData) as LoaderDataResult;
  expect(result.ok).toBe(false);
  return result;
}

function fallbackOf(result: LoaderDataResult): ReactNode {
  return result.ok ? undefined : result.fallback;
}

describe("resolveLoaders awaitBeforeFlush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestCtx._shellCaptureState = undefined;
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
    mockRequestCtx._shellCaptureState = { run: true, loaderRecords: new Map() };
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
    mockRequestCtx._shellCaptureState = { run: true, loaderRecords: new Map() };
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
    expect([...mockRequestCtx._shellCaptureState.loaderRecords.keys()]).toEqual(
      ["R0D0.flagged#L"],
    );
    // The rendered() cycle guard registers during capture too: the await
    // creates the same cycle a live document render has.
    expect([...mockRequestCtx._awaitBeforeFlushLoaderIds]).toEqual([
      "flagged#L",
    ]);
  });
});

/**
 * A flagged loader's result is decoded while the document's tree is built
 * (segment-system buildLoaderStreams); an error there with no fallback to
 * plant rejects the whole tree (dc-t92: a blank shell HIT, a raw 500 MISS).
 */
describe("resolveLoaders: a flagged loader that throws with no errorBoundary()", () => {
  const failing = (id: string) =>
    createMockLoader(id, Promise.reject(new Error(`${id} failed`)));

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestCtx._shellCaptureState = undefined;
    mockRequestCtx._awaitBeforeFlushLoaderIds = undefined;
  });

  it("renders the router's default error boundary, reported as handled, and the document answers 500", async () => {
    const onError = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const loaderError = new Error("flagged#L failed");
    const entry = createEntry([
      loaderEntry(
        createMockLoader("flagged#L", Promise.reject(loaderError)),
        true,
      ),
    ]);

    const segments = await resolveLoaders(
      entry,
      createMockCtx(),
      true,
      laneDeps(null, onError),
    );

    const fallback = fallbackOf(await settledResult(segments[0]!));
    expect(fallback).not.toBeNull();
    expect(renderToStaticMarkup(fallback)).toContain("Internal Server Error");
    expect(mockRequestCtx._setStatus).toHaveBeenCalledWith(500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      loaderError,
      expect.objectContaining({ handledByBoundary: true }),
    );
    // Printed once, the original, where the loader ran.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/^\[RSC\] Loader error \(L\) /),
      loaderError,
    );
    consoleError.mockRestore();
  });

  it("does the same on the loading-disabled path", async () => {
    const entry = {
      ...createEntry([loaderEntry(failing("flagged#L"), true)]),
      loading: false,
    };

    const segments = await resolveLoaders(
      entry,
      createMockCtx(),
      true,
      laneDeps(),
    );

    const fallback = fallbackOf(await settledResult(segments[0]!));
    expect(renderToStaticMarkup(fallback)).toContain("Internal Server Error");
    expect(mockRequestCtx._setStatus).toHaveBeenCalledWith(500);
  });

  it("keeps a declared errorBoundary()'s fallback, answers 500, and prints the original error once", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const onError = vi.fn();
    const entry = createEntry([loaderEntry(failing("flagged#L"), true)]);
    const declared = createElement("p", null, "route boundary");

    const segments = await resolveLoaders(
      entry,
      createMockCtx(),
      true,
      laneDeps(declared, onError),
    );

    const rendered = renderToStaticMarkup(
      fallbackOf(await settledResult(segments[0]!)),
    );
    expect(rendered).toBe("<p>route boundary</p>");
    expect(mockRequestCtx._setStatus).toHaveBeenCalledTimes(1);
    expect(mockRequestCtx._setStatus).toHaveBeenCalledWith(500);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ handledByBoundary: true }),
    );
    // Whatever boundary renders it, the server prints the original once.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/^\[RSC\] Loader error \(L\) /),
      expect.objectContaining({ message: "flagged#L failed" }),
    );
    consoleError.mockRestore();
  });

  it("answers a thrown redirect() as the redirect: no fallback, no 500", async () => {
    mockRequestCtx.url = new URL("https://example.com/x");
    try {
      const redirecting = createMockLoader(
        "flagged#L",
        Promise.reject(redirect("/elsewhere")),
      );
      const entry = createEntry([loaderEntry(redirecting, true)]);

      const segments = await resolveLoaders(
        entry,
        createMockCtx(),
        true,
        laneDeps(),
      );

      const result = await settledResult(segments[0]!);
      expect(result.ok ? undefined : result.redirect).toEqual({
        to: "https://example.com/elsewhere",
        status: 302,
      });
      expect(fallbackOf(result)).toBeNull();
      expect(mockRequestCtx._setStatus).not.toHaveBeenCalled();
    } finally {
      mockRequestCtx.url = undefined;
    }
  });

  it("leaves an unflagged loader's error to its read", async () => {
    const entry = createEntry([loaderEntry(failing("plain#L"))]);

    const segments = await resolveLoaders(
      entry,
      createMockCtx(),
      true,
      laneDeps(),
    );

    expect(fallbackOf(await settledResult(segments[0]!))).toBeNull();
    expect(mockRequestCtx._setStatus).not.toHaveBeenCalled();
  });

  it("leaves an unflagged loader's error to its read on the loading-disabled path", async () => {
    const entry = {
      ...createEntry([
        loaderEntry(createMockLoader("flagged#L"), true),
        loaderEntry(failing("plain#L")),
      ]),
      loading: false,
    };

    const segments = await resolveLoaders(
      entry,
      createMockCtx(),
      true,
      laneDeps(),
    );

    expect(fallbackOf(await settledResult(segments[1]!))).toBeNull();
    expect(mockRequestCtx._setStatus).not.toHaveBeenCalled();
  });
});
