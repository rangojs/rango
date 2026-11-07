/**
 * MatchContext.forceRender: a segment the client holds that a partial match
 * renders as if it were new (a navigation from an open intercept to its
 * source's own route, match-api.ts). The client set keeps the id, so every
 * new-or-held decision asks rendersAsNew (resolution-pass.ts): the walker
 * renders the forced route whatever its revalidate() says, a fill sends it,
 * and a prefetch never defers it (the plan reads the same set as held).
 */
import { describe, it, expect, vi } from "vitest";

import { resolveAllSegments } from "../revalidation.js";
import { planPrefetchDeferral } from "../prefetch-deferral.js";
import { rendersAsNew, type ResolutionPass } from "../resolution-pass.js";
import type { EntryData } from "../../../server/context.js";
import type { SegmentResolutionDeps } from "../../types.js";
import type { ResolvedSegment } from "../../../types.js";

const URL_PAGE = "http://localhost/a";

function makeDeps(): SegmentResolutionDeps<any> {
  return {
    wrapLoaderPromise: vi.fn((promise: any) => promise) as any,
    trackHandler: vi.fn((p) => p),
    findNearestErrorBoundary: vi.fn(() => null),
    findNearestNotFoundBoundary: vi.fn(() => null),
    callOnError: vi.fn(),
  };
}

function makeContext(): any {
  return {
    request: new Request(URL_PAGE),
    env: {},
    params: {},
    pathname: "/a",
    url: new URL(URL_PAGE),
    var: {},
    use: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  };
}

function entry(
  type: "layout" | "route",
  shortCode: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id: `entry.${shortCode}`,
    type,
    shortCode,
    handler: vi.fn(() => `content-${shortCode}`),
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    handle: [],
    ...overrides,
  };
}

const HELD = new Set(["L0", "L0R0"]);

/** A layout L0 and a route L0R0 whose revalidate() keeps it. */
function chainOf(routeOverrides: Record<string, unknown> = {}): {
  chain: EntryData[];
  route: any;
} {
  const route = entry("route", "L0R0", {
    revalidate: [() => false],
    ...routeOverrides,
  });
  return { chain: [entry("layout", "L0"), route], route };
}

async function resolve(
  chain: EntryData[],
  options: {
    forceRender?: string;
    mode?: "prefetch" | "fill";
    held?: ReadonlySet<string>;
  } = {},
): Promise<Record<string, ResolvedSegment>> {
  const context = makeContext();
  const held = options.held ?? HELD;
  context._prefetchDeferral = planPrefetchDeferral(
    chain,
    options.mode,
    {},
    null,
    held,
  );
  const pass: ResolutionPass = {
    context,
    client: held,
    forceRender: options.forceRender,
    params: {},
    prevParams: {},
    request: new Request(URL_PAGE),
    prevUrl: new URL(URL_PAGE),
    nextUrl: new URL(URL_PAGE),
    routeKey: "a",
    deps: makeDeps(),
  };
  const { segments } = await resolveAllSegments(pass, chain, {
    interceptResult: null,
    localRouteName: "a",
    pathname: "/a",
  });
  return Object.fromEntries(segments.map((s) => [s.id, s]));
}

describe("rendersAsNew", () => {
  it("answers true for a segment the client lacks or the match forces", () => {
    const held = { client: HELD, forceRender: "L0R0" };
    expect(rendersAsNew(held, "L0R0")).toBe(true);
    expect(rendersAsNew(held, "L0R1")).toBe(true);
    expect(rendersAsNew(held, "L0")).toBe(false);
    expect(rendersAsNew({ client: HELD }, "L0R0")).toBe(false);
  });
});

describe("a forced route segment the client holds", () => {
  it("renders although its revalidate() keeps it", async () => {
    const { chain, route } = chainOf();
    const kept = await resolve(chain);
    expect(kept.L0R0!._handlerRan).toBe(false);
    expect(route.handler).not.toHaveBeenCalled();

    const forced = await resolve(chain, { forceRender: "L0R0" });
    expect(forced.L0R0!._handlerRan).toBe(true);
    expect(forced.L0R0!.component).toBe("content-L0R0");
    expect(route.handler).toHaveBeenCalledTimes(1);
    // Only the forced id: the held layout above it is still asked.
    expect(forced.L0!._handlerRan).toBe(false);
  });

  it("renders in a fill, which keeps every other held segment", async () => {
    const { chain } = chainOf({ revalidate: [() => true] });
    const fill = await resolve(chain, { mode: "fill" });
    expect(fill.L0R0!._handlerRan).toBe(false);

    const forced = await resolve(chain, { mode: "fill", forceRender: "L0R0" });
    expect(forced.L0R0!._handlerRan).toBe(true);
  });

  it("is never deferred by a prefetch: the plan counts it held", async () => {
    // prefetch: false on the route's loading(): a unit the prefetch skips
    // while the client lacks it.
    const { chain } = chainOf({
      loading: "fallback",
      loadingPrefetch: false,
    });
    const lacked = await resolve(chain, {
      mode: "prefetch",
      held: new Set(["L0"]),
    });
    expect(lacked.L0R0!.deferred).toBe(true);

    const forced = await resolve(chain, {
      mode: "prefetch",
      forceRender: "L0R0",
    });
    expect(forced.L0R0!.deferred).toBeUndefined();
    expect(forced.L0R0!._handlerRan).toBe(true);
  });
});
