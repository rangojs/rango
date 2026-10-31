/**
 * resolveOrphanLayout (segment-resolution/revalidation.ts) marks an orphan
 * layout's segment `_handlerRan` as resolveEntryHandler marks a chain
 * entry's: true when its handler ran for this pass, false when the client
 * keeps it or a prefetch deferred it. A partial match lists the marked ids
 * in `resolvedIds` (match-result.ts), and the browser's handle merge clears
 * the old pushes of a run listed there (handles/pushed-by.ts). Unmarked, an
 * orphan that re-ran and pushed nothing kept its previous pushes.
 *
 * The userland version is
 * src/testing/__tests__/serve-shell-request-orphan-layout-resolved-ids.rsc-test.tsx.
 */
import { describe, it, expect, vi } from "vitest";

import { resolveAllSegments } from "../segment-resolution/revalidation.js";
import { makeFreshPass } from "../../__tests__/kit/resolution-pass.js";
import type { EntryData } from "../../server/context.js";
import type { SegmentResolutionDeps } from "../types.js";

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

/**
 * A layout L0 with a routeless sibling L0L0 (and a layout nested in it,
 * L0L0L0) and a route R0 whose path() declares L0R0L0. Each orphan's
 * revalidate() answers `revalidates`.
 */
function chainOf(revalidates: boolean): {
  chain: EntryData[];
  orphans: any[];
} {
  const revalidate = [() => revalidates];
  const nested = entry("layout", "L0L0L0", { revalidate });
  const sibling = entry("layout", "L0L0", { revalidate, layout: [nested] });
  const declared = entry("layout", "L0R0L0", { revalidate });
  const route = entry("route", "L0R0", { layout: [declared] });
  const layout = entry("layout", "L0", { layout: [sibling] });
  return {
    chain: [layout, route],
    orphans: [sibling, nested, declared],
  };
}

async function handlerRanOf(
  chain: EntryData[],
  client: string[] | "fresh",
): Promise<Record<string, boolean | undefined>> {
  const pass =
    client === "fresh"
      ? makeFreshPass(makeContext(), makeDeps(), { routeKey: "a" })
      : {
          context: makeContext(),
          client: new Set(client),
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
  return Object.fromEntries(
    segments
      .filter((s) => s.type === "layout" && s.id !== "L0")
      .map((s) => [s.id, s._handlerRan]),
  );
}

const HELD = ["L0", "L0L0", "L0L0L0", "L0R0", "L0R0L0"];

describe("an orphan layout's segment says whether its handler ran", () => {
  it("true for a held orphan its revalidate() re-runs", async () => {
    const { chain, orphans } = chainOf(true);
    expect(await handlerRanOf(chain, HELD)).toEqual({
      L0L0: true,
      L0L0L0: true,
      L0R0L0: true,
    });
    for (const orphan of orphans) expect(orphan.handler).toHaveBeenCalled();
  });

  it("false for a held orphan its revalidate() keeps", async () => {
    const { chain, orphans } = chainOf(false);
    expect(await handlerRanOf(chain, HELD)).toEqual({
      L0L0: false,
      L0L0L0: false,
      L0R0L0: false,
    });
    for (const orphan of orphans) {
      expect(orphan.handler).not.toHaveBeenCalled();
    }
  });

  it("true for an orphan the client lacks, and on a FRESH pass", async () => {
    const all = { L0L0: true, L0L0L0: true, L0R0L0: true };
    expect(await handlerRanOf(chainOf(false).chain, [])).toEqual(all);
    expect(await handlerRanOf(chainOf(false).chain, "fresh")).toEqual(all);
  });
});
