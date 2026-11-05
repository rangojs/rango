/**
 * The segment a handle push through `ctx.use` files under.
 *
 * A layout's or a parallel slot's ctx (withSegmentScope, handler-context.ts)
 * carries its own segment so a component the handler handed that ctx to files
 * its push under the layout or slot, not under whatever segment the walker
 * pinned since. The segment reaches `ctx.use` through the runAsSegment scope
 * of the call, so it does not depend on the call shape: a component may
 * destructure the method, hand it on as a callback, or reach it through a
 * wrapper that forwards only the item.
 */
import { describe, expect, it } from "vitest";
import { setupBuildUse, setupLoaderAccess } from "../loader-resolution.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { createHandle } from "../../handle.js";
import { withSegmentScope } from "../handler-context.js";
import type { HandlerContext } from "../../types";

const Crumbs = createHandle<string>();

function makeReqCtx() {
  return createRequestContext<Record<string, never>>({
    env: {},
    request: new Request("http://localhost/"),
    url: new URL("http://localhost/"),
    variables: {},
  });
}

/** The request's one handler ctx, pinned to the segment being resolved. */
function makeCtx(segmentId: string): HandlerContext<any, any> {
  return { _currentSegmentId: segmentId } as unknown as HandlerContext<
    any,
    any
  >;
}

function pushedSegments(
  store: { getDataForSegment: (id: string) => Record<string, unknown> },
  ids: string[],
): string[] {
  return ids.filter((id) => Crumbs.$$id in store.getDataForSegment(id));
}

const LANES = [
  {
    name: "setupLoaderAccess",
    install: (ctx: HandlerContext<any, any>) =>
      setupLoaderAccess(ctx, new Map()),
  },
  {
    name: "setupBuildUse",
    install: (ctx: HandlerContext<any, any>) => setupBuildUse(ctx),
  },
] as const;

for (const lane of LANES) {
  describe(`${lane.name}: a scoped ctx's push segment`, () => {
    /**
     * Install the lane on the request ctx, then scope a layout ctx off it, and
     * hand both to `run` inside the request scope.
     */
    async function scoped(
      run: (
        scoped: HandlerContext<any, any>,
        requestCtx: ReturnType<typeof makeReqCtx>,
        installedOn: HandlerContext<any, any>,
      ) => void,
    ): Promise<void> {
      const reqCtx = makeReqCtx();
      await runWithRequestContext(reqCtx, async () => {
        const ctx = makeCtx("R0");
        lane.install(ctx);
        run(withSegmentScope(ctx, "L0", undefined), reqCtx, ctx);
      });
    }

    it("names the scoped segment for a method call", async () => {
      await scoped((scoped, reqCtx) => {
        scoped.use(Crumbs)("v");
        expect(pushedSegments(reqCtx._handleStore, ["L0", "R0"])).toEqual([
          "L0",
        ]);
      });
    });

    it("names the scoped segment for a destructured `const { use } = ctx`", async () => {
      await scoped((scoped, reqCtx) => {
        const { use } = scoped;
        use(Crumbs)("v");
        expect(pushedSegments(reqCtx._handleStore, ["L0", "R0"])).toEqual([
          "L0",
        ]);
      });
    });

    it("names the scoped segment for a `use` passed on as a callback", async () => {
      await scoped((scoped, reqCtx) => {
        const push = [Crumbs].map(
          scoped.use as unknown as (item: typeof Crumbs) => (v: string) => void,
        )[0]!;
        push("v");
        expect(pushedSegments(reqCtx._handleStore, ["L0", "R0"])).toEqual([
          "L0",
        ]);
      });
    });

    it("names the scoped segment through a wrapper that forwards only the item", async () => {
      await scoped((scoped, reqCtx, installedOn) => {
        // Any interceptor installed on the request ctx after the child exists
        // (loader-cache.ts executeLoaderData is one).
        const installed = installedOn.use;
        installedOn.use = ((item: unknown) =>
          installed(item as never)) as never;
        scoped.use(Crumbs)("v");
        expect(pushedSegments(reqCtx._handleStore, ["L0", "R0"])).toEqual([
          "L0",
        ]);
      });
    });

    it("names the scoped segment for a copy carrying the scoped `use`", async () => {
      await scoped((scoped, reqCtx) => {
        const copy = { ...(scoped as any), use: scoped.use };
        copy.use(Crumbs)("v");
        expect(pushedSegments(reqCtx._handleStore, ["L0", "R0"])).toEqual([
          "L0",
        ]);
      });
    });

    it("leaves an unscoped ctx on its own pin", async () => {
      const reqCtx = makeReqCtx();
      await runWithRequestContext(reqCtx, async () => {
        const ctx = makeCtx("R0");
        lane.install(ctx);
        ctx.use(Crumbs)("v");
        expect(pushedSegments(reqCtx._handleStore, ["L0", "R0"])).toEqual([
          "R0",
        ]);
      });
    });
  });
}
