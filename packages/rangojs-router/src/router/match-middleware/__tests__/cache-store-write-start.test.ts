import { describe, it, expect, vi } from "vitest";
import { withCacheStore } from "../cache-store.js";
import { runWithRouterContext } from "../../router-context.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import { executionStart } from "../../../cache/tag-invalidation.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import { seg, gen, makeCacheStoreRouterContextStub } from "./helpers.js";

// #977: a route cache() record is not written when one of its tags was
// invalidated after the render started, so withCacheStore hands cacheRoute
// the start it took before the lookup and the handlers ran. A shell
// capture's implicit doc record gets none: it lives only in the shell entry,
// which putShell gates by the capture start.
async function driveMiss(isShellImplicitDocScope: boolean) {
  const cacheRoute = vi.fn(async () => {});
  const cacheScope = {
    enabled: true,
    cacheRoute,
    recordTags: vi.fn(),
    isShellImplicitDocScope,
  } as any;
  const ctx = {
    cacheScope,
    isAction: false,
    request: new Request("https://app.test/product/1"),
    pathname: "/product/1",
    clientSegmentSet: new Set<string>(),
    metricsStore: undefined,
    isIntercept: false,
    matched: { params: {}, routeKey: "product" },
    url: new URL("https://app.test/product/1"),
  } as unknown as MatchContext<any>;
  const state = {
    cacheHit: false,
    interceptSegments: [],
  } as unknown as MatchPipelineState;
  const pending: Promise<void>[] = [];
  const reqCtx = createRequestContext<any>({
    env: {},
    request: ctx.request,
    url: ctx.url,
    variables: {},
    executionContext: {
      waitUntil: (p: Promise<void>) => {
        pending.push(p);
      },
    } as any,
  });

  const before = executionStart();
  await runWithRouterContext(makeCacheStoreRouterContextStub(), () =>
    runWithRequestContext(reqCtx, async () => {
      for await (const _ of withCacheStore(ctx, state)(gen([seg("R0")]))) {
        // pass-through
      }
      for (const cb of reqCtx._onResponseCallbacks) {
        cb(new Response(null, { status: 200 }));
      }
      await Promise.all(pending);
    }),
  );
  expect(cacheRoute).toHaveBeenCalledTimes(1);
  return { start: (cacheRoute.mock.calls[0] as unknown[])[4], before };
}

describe("withCacheStore: the record's write start (#977)", () => {
  it("a route cache() record is written with the start taken before the render", async () => {
    const { start, before } = await driveMiss(false);
    expect(start).toMatchObject({ seq: before.seq });
    expect((start as { at: number }).at).toBeGreaterThanOrEqual(before.at);
  });

  it("a shell capture's implicit doc record gets none", async () => {
    const { start } = await driveMiss(true);
    expect(start).toBeUndefined();
  });
});
