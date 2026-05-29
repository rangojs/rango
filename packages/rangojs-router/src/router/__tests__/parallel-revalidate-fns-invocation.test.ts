/**
 * Regression: revalidate() functions on parallel slots must run regardless of
 * whether the parallel segment id is present in clientSegmentIds.
 *
 * Bug: when the client did not have the parallel slot in its known segment
 * set (e.g. after an action pruned it), the resolver short-circuited with a
 * static decision and never invoked the user-defined revalidate functions.
 * This test pins the contract for both the main parallel path and the orphan
 * layout path.
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
import type { EntryData } from "../../server/context.js";
import type { SegmentResolutionDeps } from "../types.js";
import type { ShouldRevalidateFn } from "../../types/handler-context.js";

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

/**
 * Layout with a parallel slot @panel that has TWO revalidate functions on it.
 * shortCode "L0" represents the layout/intercept — parallel id is "L0.@panel".
 */
function makeLayoutWithParallelSlot(
  fn1: ReturnType<typeof vi.fn>,
  fn2: ReturnType<typeof vi.fn>,
): EntryData {
  const parallelEntry = {
    id: "layout.parallel",
    type: "parallel",
    shortCode: "L0P0",
    handler: { "@panel": () => null },
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [fn1, fn2],
    errorBoundary: [],
    notFoundBoundary: [],
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

/** Orphan layout (route-belonging) with a parallel slot @panel. */
function makeOrphanLayoutWithParallelSlot(
  fn1: ReturnType<typeof vi.fn>,
  fn2: ReturnType<typeof vi.fn>,
): EntryData {
  const parallelEntry = {
    id: "orphan.parallel",
    type: "parallel",
    shortCode: "O0P0",
    handler: { "@panel": () => null },
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [fn1, fn2],
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

describe("parallel revalidate() fns invocation matrix (main path)", () => {
  const params = { mailboxId: "x", folder: "draft", emailId: "2" };
  const prevParams = { mailboxId: "x", folder: "draft", emailId: "1" };
  const request = new Request("http://localhost/mailbox/x/emails/draft/2");
  const prevUrl = new URL("http://localhost/mailbox/x/emails/draft/1");
  const nextUrl = new URL("http://localhost/mailbox/x/emails/draft/2");

  it("runs all revalidate fns when slot IS in clientSegmentIds", async () => {
    const fn1 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const fn2 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const layout = makeLayoutWithParallelSlot(fn1, fn2);
    const clientIds = new Set(["L0", "L0.@panel"]);

    await resolveParallelSegmentsWithRevalidation(
      layout,
      params,
      makeContext(),
      false, // belongsToRoute
      clientIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      makeDeps(),
    );

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("full refetch forces resolve and skips user fns (client has nothing to fall back to)", async () => {
    // Full refetch is the load-bearing "render everything" case — user fns
    // returning false here would leave the slot blank with no client-cached
    // content to keep showing. Contract: bypass user fns entirely.
    const fn1 = vi.fn(() => false); // hard-false would normally skip
    const fn2 = vi.fn(() => false);
    const layout = makeLayoutWithParallelSlot(fn1, fn2);

    const result = await resolveParallelSegmentsWithRevalidation(
      layout,
      params,
      makeContext(),
      false,
      new Set(),
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      makeDeps(),
    );

    expect(fn1).toHaveBeenCalledTimes(0);
    expect(fn2).toHaveBeenCalledTimes(0);
    expect(result.matchedIds).toContain("L0.@panel");
  });

  it("runs all revalidate fns when parent is new (isNewParent=true)", async () => {
    const fn1 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const fn2 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const layout = makeLayoutWithParallelSlot(fn1, fn2);
    // Parent L0 NOT in clientSegmentIds → isNewParent=true
    const clientIds = new Set(["someOtherSegment"]);

    await resolveParallelSegmentsWithRevalidation(
      layout,
      params,
      makeContext(),
      false,
      clientIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      makeDeps(),
    );

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("runs all revalidate fns when parallel belongs to route (belongsToRoute=true)", async () => {
    const fn1 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const fn2 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const layout = makeLayoutWithParallelSlot(fn1, fn2);
    // Slot not in clientSegmentIds, parent IS — but belongsToRoute=true
    const clientIds = new Set(["L0"]);

    await resolveParallelSegmentsWithRevalidation(
      layout,
      params,
      makeContext(),
      true, // belongsToRoute
      clientIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      makeDeps(),
    );

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  // The exact bug reported: shared parallel under known parent, slot not on
  // client. Code currently short-circuits and skips revalidate fns entirely.
  it("REGRESSION: runs revalidate fns when slot is NOT in clientSegmentIds but parent IS (parent-chain parallel)", async () => {
    const fn1 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const fn2 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const layout = makeLayoutWithParallelSlot(fn1, fn2);
    // Mirrors the user's scenario: parent (L0) known, panel (L0.@panel) not.
    const clientIds = new Set(["L0"]);

    const result = await resolveParallelSegmentsWithRevalidation(
      layout,
      params,
      makeContext(),
      false, // not part of route — pure parent-chain parallel
      clientIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      makeDeps(),
    );

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
    // Both fns soft-returned true → slot should resolve, not be null-component.
    const panelSeg = result.segments.find((s) => s.id === "L0.@panel");
    expect(panelSeg).toBeDefined();
    // matchedIds must include the slot too (otherwise client prunes it).
    expect(result.matchedIds).toContain("L0.@panel");
  });

  it("REGRESSION: hard-false from a revalidate fn still runs (and short-circuits) when slot not in clientSegmentIds", async () => {
    const fn1 = vi.fn(() => false); // hard skip
    const fn2 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const layout = makeLayoutWithParallelSlot(fn1, fn2);
    const clientIds = new Set(["L0"]);

    await resolveParallelSegmentsWithRevalidation(
      layout,
      params,
      makeContext(),
      false,
      clientIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      makeDeps(),
    );

    expect(fn1).toHaveBeenCalledTimes(1);
    // fn2 NOT called because fn1 hard-returned — but the fact that fn1 is
    // called at all is the regression check.
    expect(fn2).toHaveBeenCalledTimes(0);
  });

  it("void / undefined / null return defers to current suggestion and continues the chain", async () => {
    // Dual coverage:
    //
    // 1) TS REGRESSION — the explicit `: ShouldRevalidateFn<any, any>`
    //    annotations on voidReturn/undefinedReturn/nullReturn force tsc to
    //    check that the return type accepts `void` (implicit no-return),
    //    `undefined`, and `null`. If someone reverts the type back to
    //    `boolean | { defaultShouldRevalidate: boolean }`, these three
    //    lines will fail to compile, surfacing the regression at typecheck
    //    time before any test runs. Do not remove the annotations to "make
    //    it terser" — they're load-bearing for the type contract.
    //
    // 2) RUNTIME — the chain must keep iterating past each "no opinion"
    //    return and let the trailing fn set the final answer. evaluateRevalidation
    //    treats null/undefined as "defer to current default" (revalidation.ts).
    const voidReturn: ShouldRevalidateFn<any, any> = vi.fn(() => {
      // implicit return — consumer-friendly shorthand
    });
    const undefinedReturn: ShouldRevalidateFn<any, any> = vi.fn(
      () => undefined,
    );
    const nullReturn: ShouldRevalidateFn<any, any> = vi.fn(() => null);
    const deciding = vi.fn(() => true);

    const parallelEntry = {
      id: "layout.parallel",
      type: "parallel",
      shortCode: "L0P0",
      handler: { "@panel": () => null },
      loader: [],
      layout: [],
      parallel: {},
      intercept: [],
      middleware: [],
      revalidate: [voidReturn, undefinedReturn, nullReturn, deciding],
      errorBoundary: [],
      notFoundBoundary: [],
    } as any;
    const layout = {
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
    const clientIds = new Set(["L0", "L0.@panel"]);

    await resolveParallelSegmentsWithRevalidation(
      layout,
      params,
      makeContext(),
      false,
      clientIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      makeDeps(),
    );

    expect(voidReturn).toHaveBeenCalledTimes(1);
    expect(undefinedReturn).toHaveBeenCalledTimes(1);
    expect(nullReturn).toHaveBeenCalledTimes(1);
    expect(deciding).toHaveBeenCalledTimes(1);
  });
});

describe("parallel revalidate() fns invocation matrix (orphan layout path)", () => {
  const params = { mailboxId: "x", folder: "draft", emailId: "2" };
  const prevParams = { mailboxId: "x", folder: "draft", emailId: "1" };
  const request = new Request("http://localhost/mailbox/x/emails/draft/2");
  const prevUrl = new URL("http://localhost/mailbox/x/emails/draft/1");
  const nextUrl = new URL("http://localhost/mailbox/x/emails/draft/2");

  it("runs all revalidate fns when slot IS in clientSegmentIds", async () => {
    const fn1 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const fn2 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const orphan = makeOrphanLayoutWithParallelSlot(fn1, fn2);
    const clientIds = new Set(["O0", "O0.@panel"]);

    await resolveOrphanLayoutWithRevalidation(
      orphan,
      params,
      makeContext(),
      clientIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      true, // belongsToRoute
      makeDeps(),
    );

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("orphan path: full refetch forces resolve and skips user fns", async () => {
    const fn1 = vi.fn(() => false);
    const fn2 = vi.fn(() => false);
    const orphan = makeOrphanLayoutWithParallelSlot(fn1, fn2);

    await resolveOrphanLayoutWithRevalidation(
      orphan,
      params,
      makeContext(),
      new Set(),
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      true,
      makeDeps(),
    );

    expect(fn1).toHaveBeenCalledTimes(0);
    expect(fn2).toHaveBeenCalledTimes(0);
  });

  it("REGRESSION: runs revalidate fns when slot is NOT in clientSegmentIds (orphan path)", async () => {
    const fn1 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const fn2 = vi.fn(() => ({ defaultShouldRevalidate: true }));
    const orphan = makeOrphanLayoutWithParallelSlot(fn1, fn2);
    // Orphan known, panel slot not.
    const clientIds = new Set(["O0"]);

    await resolveOrphanLayoutWithRevalidation(
      orphan,
      params,
      makeContext(),
      clientIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      "mailbox.email",
      true,
      makeDeps(),
    );

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});
