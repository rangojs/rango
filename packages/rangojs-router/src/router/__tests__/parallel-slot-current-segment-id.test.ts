/**
 * Regression coverage for parallel-slot handle pushes.
 *
 * Two intertwined contracts:
 *
 * 1. `ctx.use(Handle)` inside a parallel slot handler must not throw the
 *    "used outside of handler context" error during slot-only revalidations.
 *    This means `_currentSegmentId` must be set before the slot handler
 *    runs (layouts/routes already do this; parallel slots historically did
 *    not, so handles only worked by accidental inheritance from the parent
 *    layout's handler).
 *
 * 2. The id used for handle pushes must be the slot's own parallel id
 *    (`<parent>.<slot>`), NOT the parent's. Parent-keying collapses slot
 *    pushes into the parent layout's bucket; on slot-only revalidations the
 *    partial-update merge then replaces the parent's bucket and drops the
 *    layout's own pushes (e.g. a Meta title template). Slot-keyed pushes
 *    keep parent and slot in separate buckets.
 *
 * For (2) to be consumer-visible, `filterSegmentOrder()` (used by
 * setHandleData cleanup and by collectHandleData ordering) must retain
 * parallel slot ids. This file pins both halves of the contract — slot-id
 * keying at the resolution sites, and filter-survival at the consumer.
 *
 * Layout-mounted-slot end-to-end behavior (where the per-bucket merge
 * actually runs) is covered by event-controller.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: false,
}));

vi.mock("../segment-resolution/loader-cache.js", () => ({
  resolveLoaderData: vi.fn(() => Promise.resolve({ data: "test" })),
}));

vi.mock("../segment-resolution/helpers.js", () => ({
  handleHandlerResult: vi.fn((x: any) => x),
  tryStaticHandler: vi.fn(),
  tryStaticSlot: vi.fn(),
  resolveLayoutComponent: vi.fn(() => Promise.resolve(null)),
  resolveWithErrorBoundary: vi.fn(
    async (_entry: any, _params: any, resolver: () => any) => resolver(),
  ),
}));

vi.mock("../router-context.js", () => ({
  getRouterContext: vi.fn(() => null),
}));

vi.mock("../telemetry.js", () => ({
  resolveSink: vi.fn(() => null),
  safeEmit: vi.fn(),
}));

vi.mock("../../server/context.js", async () => {
  const actual = await vi.importActual("../../server/context.js");
  return {
    ...(actual as object),
    track: vi.fn(() => vi.fn()),
    runInsideLoaderScope: <T>(fn: () => T): T => fn(),
  };
});

import {
  resolveParallelSegmentsWithRevalidation,
  resolveOrphanLayoutWithRevalidation,
} from "../segment-resolution/revalidation.js";
import { resolveParallelEntry } from "../segment-resolution/fresh.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import type { EntryData } from "../../server/context.js";
import type { SegmentResolutionDeps } from "../types.js";

function makeDeps(): SegmentResolutionDeps<any> {
  return {
    wrapLoaderPromise: vi.fn(async (promise: any) => ({
      data: await promise,
      error: null,
    })) as any,
    trackHandler: vi.fn((p) => p),
    findNearestErrorBoundary: vi.fn(() => null),
    findNearestNotFoundBoundary: vi.fn(() => null),
    callOnError: vi.fn(),
  };
}

/**
 * `_currentSegmentId` is left undefined on the context so the test proves the
 * slot-resolution path itself sets it (rather than inheriting from a previous
 * handler).
 */
function makeContext(): any {
  return {
    request: new Request("http://localhost/mailbox/x/emails/draft/2"),
    env: {},
    params: { mailboxId: "x", folder: "draft", emailId: "2" },
    pathname: "/mailbox/x/emails/draft/2",
    url: new URL("http://localhost/mailbox/x/emails/draft/2"),
    var: {},
    use: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  };
}

function makeLayoutWithSlotHandler(
  slotHandler: (ctx: any) => any,
  loading?: () => null,
): EntryData {
  const parallelEntry = {
    id: "layout.parallel",
    type: "parallel",
    shortCode: "L0P0",
    handler: { "@panel": slotHandler },
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [() => ({ defaultShouldRevalidate: true })],
    errorBoundary: [],
    notFoundBoundary: [],
    ...(loading ? { loading } : {}),
  } as any;

  return {
    id: "layout",
    type: "layout",
    shortCode: "L0",
    handler: () => null,
    loader: [],
    layout: [],
    parallel: { "@panel": parallelEntry },
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    handle: [],
  } as any;
}

function makeOrphanLayoutWithSlotHandler(
  slotHandler: (ctx: any) => any,
): EntryData {
  const parallelEntry = {
    id: "orphan.parallel",
    type: "parallel",
    shortCode: "O0P0",
    handler: { "@panel": slotHandler },
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [() => ({ defaultShouldRevalidate: true })],
    errorBoundary: [],
    notFoundBoundary: [],
  } as any;

  return {
    id: "orphan",
    type: "layout",
    shortCode: "O0",
    handler: () => null,
    loader: [],
    layout: [],
    parallel: { "@panel": parallelEntry },
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    handle: [],
  } as any;
}

describe("parallel slot handlers (revalidation main path)", () => {
  const params = { mailboxId: "x", folder: "draft", emailId: "2" };
  const prevParams = { mailboxId: "x", folder: "draft", emailId: "1" };
  const request = new Request("http://localhost/mailbox/x/emails/draft/2");
  const prevUrl = new URL("http://localhost/mailbox/x/emails/draft/1");
  const nextUrl = new URL("http://localhost/mailbox/x/emails/draft/2");

  it("keys _currentSegmentId to the slot's parallel id (await branch)", async () => {
    let observedSegmentId: string | undefined;
    const layout = makeLayoutWithSlotHandler((ctx: any) => {
      observedSegmentId = ctx._currentSegmentId;
      return null;
    });

    await resolveParallelSegmentsWithRevalidation(
      layout,
      params,
      makeContext(),
      false,
      new Set(["L0", "L0.@panel"]),
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      makeDeps(),
    );

    expect(observedSegmentId).toBe("L0.@panel");
    // Slot id must survive the filter or the consumer drops it.
    expect(filterSegmentOrder([observedSegmentId!])).toContain("L0.@panel");
  });

  it("keys _currentSegmentId to the slot's parallel id (loading-fallback / streamed branch)", async () => {
    let observedSegmentId: string | undefined;
    const layout = makeLayoutWithSlotHandler(
      (ctx: any) => {
        observedSegmentId = ctx._currentSegmentId;
        return Promise.resolve(null);
      },
      () => null,
    );

    await resolveParallelSegmentsWithRevalidation(
      layout,
      params,
      makeContext(),
      false,
      new Set(["L0", "L0.@panel"]),
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      makeDeps(),
    );

    expect(observedSegmentId).toBe("L0.@panel");
    expect(filterSegmentOrder([observedSegmentId!])).toContain("L0.@panel");
  });
});

describe("parallel slot handlers (revalidation orphan path)", () => {
  const params = { mailboxId: "x", folder: "draft", emailId: "2" };
  const prevParams = { mailboxId: "x", folder: "draft", emailId: "1" };
  const request = new Request("http://localhost/mailbox/x/emails/draft/2");
  const prevUrl = new URL("http://localhost/mailbox/x/emails/draft/1");
  const nextUrl = new URL("http://localhost/mailbox/x/emails/draft/2");

  it("keys _currentSegmentId to the slot's parallel id", async () => {
    let observedSegmentId: string | undefined;
    const orphan = makeOrphanLayoutWithSlotHandler((ctx: any) => {
      observedSegmentId = ctx._currentSegmentId;
      return null;
    });

    await resolveOrphanLayoutWithRevalidation(
      orphan,
      params,
      makeContext(),
      new Set(["O0", "O0.@panel"]),
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      true,
      makeDeps(),
    );

    expect(observedSegmentId).toBe("O0.@panel");
    expect(filterSegmentOrder([observedSegmentId!])).toContain("O0.@panel");
  });
});

describe("parallel slot handlers (fresh path)", () => {
  it("keys _currentSegmentId to '<parent>.<slot>'", async () => {
    let observedSegmentId: string | undefined;
    const slotHandler = (ctx: any) => {
      observedSegmentId = ctx._currentSegmentId;
      return null;
    };

    const parallelEntry = {
      id: "layout.parallel",
      type: "parallel",
      shortCode: "L0P0",
      handler: { "@panel": slotHandler },
      loader: [],
      layout: [],
      parallel: {},
      intercept: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;

    await resolveParallelEntry(
      parallelEntry,
      { mailboxId: "x", folder: "draft", emailId: "2" },
      makeContext(),
      false,
      "L0",
      makeDeps(),
      undefined,
      "mailbox.email",
      ["@panel"],
      true,
    );

    expect(observedSegmentId).toBe("L0.@panel");
    expect(filterSegmentOrder([observedSegmentId!])).toContain("L0.@panel");
  });
});

/**
 * End-to-end-ish guard: pushes go through the same `ctx.use(handle)`
 * capture-and-bind pattern as `loader-resolution.ts:399`. The captured
 * segmentId is what `HandleStore.push()` is called with, so this pins the
 * actual key the bucket lands under for downstream consumers.
 */
describe("parallel-slot handle pushes use slot-keyed buckets that survive filterSegmentOrder", () => {
  it("captures slot-keyed segmentId at ctx.use call time", async () => {
    const pushes: { handleId: string; segmentId: string; data: unknown }[] = [];
    const fakeStore = {
      push: (handleId: string, segmentId: string, data: unknown) => {
        pushes.push({ handleId, segmentId, data });
      },
    };

    const slotHandler = (ctx: any) => {
      const segmentId = ctx._currentSegmentId;
      if (!segmentId) {
        throw new Error("Handle used outside of handler context");
      }
      const push = (data: unknown) => {
        fakeStore.push("Meta", segmentId, data);
      };
      push({ title: "Inbox · Email B" });
      return null;
    };

    const parallelEntry = {
      id: "layout.parallel",
      type: "parallel",
      shortCode: "L0P0",
      handler: { "@panel": slotHandler },
      loader: [],
      layout: [],
      parallel: {},
      intercept: [],
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;

    await resolveParallelEntry(
      parallelEntry,
      { mailboxId: "x", folder: "draft", emailId: "2" },
      makeContext(),
      false,
      "L0",
      makeDeps(),
      undefined,
      "mailbox.email",
      ["@panel"],
      true,
    );

    expect(pushes).toHaveLength(1);
    expect(pushes[0].segmentId).toBe("L0.@panel");
    expect(filterSegmentOrder([pushes[0].segmentId])).toEqual(["L0.@panel"]);
  });
});
