// The seed evaluateRevalidation hands a held segment: a stale request
// (`_rsc_stale`) takes an action's defaults; a navigation and a route-cache
// entry past its TTL keep a navigation's.
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushed = vi.hoisted(
  () => [] as { reason: string; finalShouldRevalidate: boolean }[],
);

vi.mock("../logging.js", () => ({
  debugLog: vi.fn(),
  pushRevalidationTraceEntry: (entry: {
    reason: string;
    finalShouldRevalidate: boolean;
  }) => pushed.push(entry),
  isTraceActive: () => true,
}));

vi.mock("../../server/request-context.js", () => ({
  _getRequestContext: () => ({ _prevRouteKey: undefined }),
}));

import { evaluateRevalidation } from "../revalidation.js";
import type { ResolvedSegment } from "../../types.js";

type SegmentShape = Pick<ResolvedSegment, "type" | "belongsToRoute">;

const ROUTE: SegmentShape = { type: "route", belongsToRoute: true };
const LOADER: SegmentShape = { type: "loader", belongsToRoute: false };
const ROUTE_CHILD: SegmentShape = { type: "layout", belongsToRoute: true };
const PARENT_LAYOUT: SegmentShape = { type: "layout", belongsToRoute: false };

interface SeedOptions {
  method?: string;
  stale?: boolean;
  cacheStale?: boolean;
}

/**
 * One held segment of /cart revalidated on /cart, no param or search change:
 * the decision and its trace reason with no revalidate(), and the `stale` a
 * deferring predicate sees.
 */
async function seed(
  shape: SegmentShape,
  options: SeedOptions = {},
): Promise<{ value: boolean; reason: string; seenStale: unknown }> {
  let seenStale: unknown;
  const evaluate = (revalidations: { name: string; fn: unknown }[]) =>
    evaluateRevalidation({
      segment: {
        id: "seg",
        namespace: "seg",
        index: 0,
        component: null,
        params: {},
        ...shape,
      },
      prevParams: {},
      getPrevSegment: null,
      request: new Request("http://localhost/cart", {
        method: options.method ?? "GET",
      }),
      prevUrl: new URL("http://localhost/cart"),
      nextUrl: new URL("http://localhost/cart"),
      revalidations,
      routeKey: "cart",
      context: {} as never,
      stale: options.stale,
      cacheStale: options.cacheStale,
    });
  pushed.length = 0;
  const value = await evaluate([]);
  const reason = pushed[0]!.reason;
  await evaluate([
    {
      name: "seen",
      fn: ({ stale }: { stale?: boolean }) => {
        seenStale = stale;
      },
    },
  ]);
  return { value, reason, seenStale };
}

beforeEach(() => {
  pushed.length = 0;
});

describe("evaluateRevalidation seeds", () => {
  it.each([
    ["a stale request", ROUTE, { stale: true }, true, "stale:route-segment"],
    ["a stale request", LOADER, { stale: true }, true, "stale:loader-segment"],
    [
      "a stale request",
      ROUTE_CHILD,
      { stale: true },
      true,
      "stale:belongs-to-route",
    ],
    [
      "a stale request",
      PARENT_LAYOUT,
      { stale: true },
      false,
      "stale:parent-chain-skip",
    ],
    ["an action", ROUTE, { method: "POST" }, true, "action:route-segment"],
    [
      "an action, stale too",
      LOADER,
      { method: "POST", stale: true },
      true,
      "action:loader-segment",
    ],
    [
      "an action",
      PARENT_LAYOUT,
      { method: "POST" },
      false,
      "action:parent-chain-skip",
    ],
    ["a navigation", ROUTE, {}, false, "nav:params-unchanged"],
    ["a navigation", LOADER, {}, false, "nav:non-route-skip"],
  ] satisfies [string, SegmentShape, SeedOptions, boolean, string][])(
    "%s seeds a %o segment",
    async (_request, shape, options, value, reason) => {
      expect(await seed(shape, options)).toMatchObject({ value, reason });
    },
  );

  it.each([ROUTE, LOADER, ROUTE_CHILD])(
    "a cache entry past its TTL alone never seeds the action defaults (%o); the predicate sees it as stale",
    async (shape) => {
      const seeded = await seed(shape, { cacheStale: true });
      expect(seeded.value).toBe(false);
      expect(seeded.reason).toMatch(/^nav:/);
      expect(seeded.seenStale).toBe(true);
    },
  );
});
