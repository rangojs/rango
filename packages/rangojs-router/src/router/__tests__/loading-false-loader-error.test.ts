import { describe, it, expect, vi } from "vitest";
import { resolveLoaders } from "../segment-resolution/fresh.js";
import type { EntryData } from "../../server/context";
import type { SegmentResolutionDeps } from "../types.js";

// wrapLoaderPromise mirrors the real contract: it NEVER rejects. It resolves to
// a LoaderDataResult, routing a failed loader to its own per-loader error result
// (which renders that loader's error boundary) rather than throwing.
function makeDeps(): SegmentResolutionDeps<any> {
  return {
    wrapLoaderPromise: vi.fn(async (promise: Promise<any>) => {
      try {
        return { ok: true, data: await promise };
      } catch (error) {
        return { ok: false, error };
      }
    }),
    trackHandler: vi.fn((p) => p),
    findNearestErrorBoundary: vi.fn(() => null),
    findNearestNotFoundBoundary: vi.fn(() => null),
    callOnError: vi.fn(),
  } as unknown as SegmentResolutionDeps<any>;
}

function loaderEntry(id: string) {
  return {
    loader: Object.assign(() => {}, { $$id: id }),
    cache: undefined,
  };
}

function makeEntry(): EntryData {
  return {
    id: "route0",
    shortCode: "R0",
    type: "route",
    loading: false, // loadingDisabled branch
    loader: [loaderEntry("ok-loader"), loaderEntry("boom-loader")],
  } as unknown as EntryData;
}

function makeCtx() {
  return {
    params: { id: "7" },
    pathname: "/test",
    request: new Request("https://app.test/test?x=1"),
    url: new URL("https://app.test/test?x=1"),
    env: { region: "eu" },
    _routeName: "test.route",
    use: vi.fn((loader: { $$id: string }) =>
      loader.$$id === "boom-loader"
        ? Promise.reject(new Error("loader boom"))
        : Promise.resolve({ value: 42 }),
    ),
  } as any;
}

describe("resolveLoaders — loading:false with a rejecting loader (M10)", () => {
  it("does not reject; routes the failure to a per-loader result and keeps sibling data", async () => {
    const deps = makeDeps();
    const ctx = makeCtx();

    // Must not propagate the rejection to the segment-level boundary: the
    // loading:false path wraps each loader before awaiting, so resolveLoaders
    // resolves with one error result and one successful sibling result.
    const segments = await resolveLoaders(makeEntry(), ctx, true, deps);

    expect(segments).toHaveLength(2);
    const ok = await (segments[0]!.loaderData as Promise<any>);
    const boom = await (segments[1]!.loaderData as Promise<any>);
    expect(ok).toEqual({ ok: true, data: { value: 42 } });
    expect(boom.ok).toBe(false);
    expect(boom.error).toBeInstanceOf(Error);
  });

  it("threads errorContext into wrapLoaderPromise so a throwing DSL loader can fire onError/loader.error", async () => {
    // wrapLoaderPromise only wires the consumer onError callback and the
    // loader.error telemetry emit when its 5th errorContext arg is present. The
    // call site previously omitted it, so loader failures were silently dropped.
    const deps = makeDeps();
    const ctx = makeCtx();

    await resolveLoaders(makeEntry(), ctx, true, deps);

    const calls = (deps.wrapLoaderPromise as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls.length).toBe(2);
    for (const call of calls) {
      // arg 5 (index 4) is the errorContext carrying the reporting fields.
      const errorContext = call[4];
      expect(errorContext).toBeDefined();
      expect(errorContext.request).toBe(ctx.request);
      expect(errorContext.url).toBe(ctx.url);
      expect(errorContext.routeKey).toBe("test.route");
      expect(errorContext.params).toEqual({ id: "7" });
      expect(errorContext.env).toEqual({ region: "eu" });
    }
  });
});
