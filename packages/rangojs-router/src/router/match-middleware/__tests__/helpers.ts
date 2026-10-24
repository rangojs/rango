import { vi } from "vitest";
import type { ResolvedSegment } from "../../../types.js";

/** Minimal ResolvedSegment for withCacheStore/withCacheLookup pipeline tests. */
export function seg(
  id: string,
  overrides: Partial<ResolvedSegment> = {},
): ResolvedSegment {
  return {
    id,
    namespace: id,
    type: "route",
    index: 0,
    component: {} as any, // non-null so hasNullComponents stays false (direct path)
    params: {},
    belongsToRoute: true,
    ...overrides,
  } as ResolvedSegment;
}

/** Wrap an array as the middleware's async segment source. */
export async function* gen(
  segments: ResolvedSegment[],
): AsyncGenerator<ResolvedSegment> {
  for (const s of segments) yield s;
}

/**
 * Router-context stub for withCacheStore tests: the direct-cache path
 * destructures these but never calls them.
 */
export function makeCacheStoreRouterContextStub(): any {
  return {
    createHandlerContext: vi.fn(),
    setupLoaderAccess: vi.fn(),
    resolveAllSegments: vi.fn(),
    resolveInterceptEntry: vi.fn(),
    createHandleStore: vi.fn(),
  } as any;
}
