/**
 * The segment a `ctx.use(Handle)` push files under, for every call shape a
 * component the handler handed its ctx to can use.
 *
 * A layout's or a parallel slot's ctx is the one case the walker's segment
 * scope cannot reach: React renders the components that ctx was handed to
 * after the handler returned, outside every `runAsSegment`, and by then the
 * shared `_currentSegmentId` names a later segment (the child route). The
 * scoped ctx therefore owns `use`, and it scopes each call with the segment it
 * was created for.
 *
 * The call shapes matter: resolving the segment from `this` (the receiver of
 * `ctx.use`) looks right for `ctx.use(Handle)` and silently falls back to the
 * request ctx's pin for `const { use } = ctx`, for a `use` passed on as a
 * callback, and for a wrapper that forwards only the item. Every shape below
 * files under the layout's segment, with the walker's pin already moved on.
 */
import { describe, expect, it } from "vitest";
import { setupBuildUse, setupLoaderAccess } from "../loader-resolution.js";
import { withSegmentScope } from "../handler-context.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { createHandle } from "../../handle.js";
import type { HandlerContext, LoaderContext } from "../../types";

const Crumbs = createHandle<string>();

/** The layout segment the scoped ctx belongs to. */
const LAYOUT = "M0L0L0";
/** The pin the walker left behind: the child route's segment. */
const ROUTE = "M0L0L0R0";

function makeReqCtx() {
  return createRequestContext<any>({
    env: {},
    request: new Request("http://localhost/"),
    url: new URL("http://localhost/"),
    variables: {},
  });
}

/** A wrapper on the request ctx's `use` that forwards only the item. */
function wrapUse(requestCtx: any): void {
  const installed = requestCtx.use;
  requestCtx.use = (item: any) => installed(item);
}

type Setup = (ctx: HandlerContext<any, any>) => void;

interface Lane {
  name: string;
  setup: Setup;
}

const LANES: Lane[] = [
  {
    name: "setupLoaderAccess",
    setup: (ctx) => setupLoaderAccess(ctx, new Map()),
  },
  { name: "setupBuildUse", setup: (ctx) => setupBuildUse(ctx) },
];

/** The handle ids the request's store holds for each segment. */
function pushedSegments(reqCtx: any): { layout: string[]; route: string[] } {
  return {
    layout: Object.keys(reqCtx._handleStore.getDataForSegment(LAYOUT)),
    route: Object.keys(reqCtx._handleStore.getDataForSegment(ROUTE)),
  };
}

/**
 * Push through a scoped layout ctx while the walker's pin is already the
 * child route's, and report where the push landed.
 */
async function pushThroughLayout(
  setup: Setup,
  shape: (ctx: HandlerContext<any, any>) => void | Promise<void>,
  options: {
    awaitFirst?: boolean;
    wrapper?: "before" | "after";
    scope?: boolean;
  } = {},
): Promise<{ layout: string[]; route: string[] }> {
  const reqCtx = makeReqCtx();
  let pushed = { layout: [] as string[], route: [] as string[] };
  await runWithRequestContext(reqCtx, async () => {
    const requestCtx = {
      _currentSegmentId: ROUTE,
      reverse: () => "/",
    } as any;
    setup(requestCtx);
    if (options.wrapper === "before") wrapUse(requestCtx);
    const layoutCtx = withSegmentScope(
      requestCtx,
      LAYOUT,
      options.scope ? { prefix: "account", rootScoped: false } : undefined,
    );
    if (options.wrapper === "after") wrapUse(requestCtx);
    if (options.awaitFirst) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await shape(layoutCtx);
    pushed = pushedSegments(reqCtx);
  });
  return pushed;
}

const PUSHED_UNDER_LAYOUT = { layout: [Crumbs.$$id], route: [] };

describe.each(LANES)(
  "$name: a push through a layout's ctx files under the layout",
  ({ setup }) => {
    it("called as a method", async () => {
      expect(
        await pushThroughLayout(setup, (ctx) => {
          ctx.use(Crumbs)("crumb");
        }),
      ).toEqual(PUSHED_UNDER_LAYOUT);
    });

    it("destructured off the ctx", async () => {
      expect(
        await pushThroughLayout(setup, (ctx) => {
          const { use } = ctx;
          use(Crumbs)("crumb");
        }),
      ).toEqual(PUSHED_UNDER_LAYOUT);
    });

    it("passed on as a callback", async () => {
      expect(
        await pushThroughLayout(setup, (ctx) => {
          [ctx.use].forEach((use) => use(Crumbs)("crumb"));
        }),
      ).toEqual(PUSHED_UNDER_LAYOUT);
    });

    it("through a wrapper that forwards only the item", async () => {
      expect(
        await pushThroughLayout(
          setup,
          (ctx) => {
            ctx.use(Crumbs)("crumb");
          },
          { wrapper: "before" },
        ),
      ).toEqual(PUSHED_UNDER_LAYOUT);
      // A wrapper installed after the scoped ctx was created too.
      expect(
        await pushThroughLayout(
          setup,
          (ctx) => {
            ctx.use(Crumbs)("crumb");
          },
          { wrapper: "after" },
        ),
      ).toEqual(PUSHED_UNDER_LAYOUT);
    });

    it("after an await, once the walker moved on", async () => {
      expect(
        await pushThroughLayout(
          setup,
          (ctx) => {
            const { use } = ctx;
            use(Crumbs)("crumb");
          },
          { awaitFirst: true },
        ),
      ).toEqual(PUSHED_UNDER_LAYOUT);
    });

    it("through a copy that carries `use`", async () => {
      expect(
        await pushThroughLayout(setup, (ctx) => {
          const copy = { ...ctx, use: ctx.use };
          copy.use(Crumbs)("crumb");
        }),
      ).toEqual(PUSHED_UNDER_LAYOUT);
    });

    it("with a reverse scope on the same ctx", async () => {
      expect(
        await pushThroughLayout(
          setup,
          (ctx) => {
            ctx.use(Crumbs)("crumb");
          },
          { scope: true },
        ),
      ).toEqual(PUSHED_UNDER_LAYOUT);
    });
  },
);

describe("the request ctx keeps its own segment", () => {
  it("a route handler's push still files under the pin", async () => {
    const reqCtx = makeReqCtx();
    await runWithRequestContext(reqCtx, async () => {
      const requestCtx = { _currentSegmentId: ROUTE } as any;
      setupLoaderAccess(requestCtx, new Map());
      requestCtx.use(Crumbs)("crumb");
      expect(pushedSegments(reqCtx)).toEqual({
        layout: [],
        route: [Crumbs.$$id],
      });
    });
  });
});

describe("a loader a scoped ctx starts after an await", () => {
  it("attributes its pushes to the layout, the segment whose code started it", async () => {
    const reqCtx = makeReqCtx();
    const Body = {
      __brand: "loader" as const,
      $$id: "layout-loader",
      fn: async (ctx: LoaderContext<any, any>) => {
        ctx.use(Crumbs)("from-loader");
        return "done";
      },
    };
    await runWithRequestContext(reqCtx, async () => {
      const requestCtx = {
        _currentSegmentId: ROUTE,
        waitUntil: () => {},
        request: new Request("http://localhost/"),
        url: new URL("http://localhost/"),
        params: {},
      } as any;
      setupLoaderAccess(requestCtx, new Map());
      const layoutCtx = withSegmentScope(requestCtx, LAYOUT, undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await layoutCtx.use(Body as any);
      expect(pushedSegments(reqCtx)).toEqual(PUSHED_UNDER_LAYOUT);
    });
  });
});
