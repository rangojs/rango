/**
 * A parallel() slot whose handler declares loading() answers a Response the
 * handler produces on an action's revalidation as a route handler under
 * loading() does: the answer is 204 with X-RSC-Redirect, not a 200 whose
 * Flight payload carries the Response as the slot's component (which the
 * browser then fails to render, staying on the page).
 *
 * resolveParallelSlotComponent streamed every async slot handler under the
 * slot's loading(), action or not, and its awaited path left a returned
 * Response as the component. An action awaits the handlers its revalidation
 * re-renders (segment-resolution/revalidation.ts resolveRouteComponent), so a
 * thrown or returned Response short-circuits the request there.
 *
 * The same slot still streams on a navigation, where a route handler under
 * loading() streams too: the slot's loading() fallback is its own contract,
 * and only the action awaits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { createRouter, redirect, urls } from "../../index.rsc.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { ResolvedSegment } from "../../types.js";

const REDIRECT_TO = "/target";
/** The redirect as the browser reads it off the action's answer. */
const REDIRECT_HEADER = "http://localhost/target";

/** A handler's ctx, as much as these handlers read of it. */
interface HandlerCtx {
  request: Request;
}

/** The action's POST is when the handler redirects; the opening navigation renders. */
function isActionRequest(ctx: HandlerCtx): boolean {
  return ctx.request.method === "POST";
}

/** How the handler produces the redirect. */
type Produces = "throws" | "returns";

/**
 * The slot handler every router here uses: the slot on the navigation that
 * opens the page, a redirect on the action's revalidation. Async, so it
 * streams under loading() on a navigation.
 */
function handlerProducing(produces: Produces) {
  return async (ctx: HandlerCtx): Promise<React.ReactNode | Response> => {
    if (isActionRequest(ctx)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (produces === "throws") throw redirect(REDIRECT_TO);
      return redirect(REDIRECT_TO);
    }
    return <aside>slot</aside>;
  };
}

/** An async handler that renders instead of redirecting. */
async function plainHandler(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return <aside>slot</aside>;
}

/** An async handler that redirects on every request, navigation included. */
async function alwaysRedirecting(): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return redirect(REDIRECT_TO);
}

interface Metadata {
  segments: ResolvedSegment[];
  matched: string[];
}

async function metadataOf(result: ServeShellRequestResult): Promise<Metadata> {
  const { metadata } = await deserializeResult<{ metadata: Metadata }>(
    result.flight!,
  );
  return metadata;
}

/** The slot segment of the answer, whatever it holds. */
function slotOf(metadata: Metadata): ResolvedSegment | undefined {
  return metadata.segments.find((s) => s.type === "parallel");
}

/** The route segment of the answer. */
function routeOf(metadata: Metadata): ResolvedSegment | undefined {
  return metadata.segments.find((s) => s.type === "route");
}

let actionSeq = 0;

async function touch(): Promise<string> {
  return "touched";
}

/** The action call the page makes, as browser/server-action-bridge.ts sends it. */
function actionOf(segments: readonly string[]) {
  return {
    ref: touch,
    id: `src/slot.actions.ts#touch${++actionSeq}`,
    segments,
  };
}

/** The /item page as the browser holds it, opened from /page. */
async function itemSegments(router: Router): Promise<readonly string[]> {
  return (
    await metadataOf(
      await serveShellRequest(router, "/item", {
        partial: { from: "/page", segments: [] },
      }),
    )
  ).matched;
}

/** The action the /item page sends, with the segments it holds. */
async function actOnItem(router: Router): Promise<ServeShellRequestResult> {
  return serveShellRequest(router, "/item", {
    action: actionOf(await itemSegments(router)),
  });
}

type Router = ReturnType<typeof makeRouter>;

/**
 * A router with /page and /item, where the handler and its loading()
 * declaration sit on /item's own `@side` slot or, with `onRoute`, on /item's
 * route.
 */
function makeRouter(options: {
  produces?: Produces;
  slotHandler?: (
    ctx: HandlerCtx,
  ) => React.ReactNode | Response | Promise<React.ReactNode | Response>;
  declareLoading?: boolean;
  /** Put the handler and its loading() on /item's route instead. */
  onRoute?: boolean;
  /** Give the layout an errorBoundary(): where the slot's handler error renders. */
  errorBoundary?: boolean;
}) {
  const {
    produces = "throws",
    slotHandler = handlerProducing(produces),
    declareLoading = true,
    onRoute = false,
    errorBoundary = false,
  } = options;
  return createRouter({}).routes(
    urls(({ path, layout, parallel, loading, errorBoundary: boundary }) => [
      layout(
        () => <main>shell</main>,
        () => [
          ...(errorBoundary ? [boundary(() => <p>failed</p>)] : []),
          path("/page", () => <p>page</p>, { name: "page" }),
          path(
            "/item",
            onRoute ? slotHandler : () => <article>item</article>,
            { name: "item" },
            () => [
              ...(onRoute && declareLoading ? [loading(<p>opening</p>)] : []),
              ...(onRoute
                ? []
                : [
                    parallel({ "@side": slotHandler }, () => [
                      ...(declareLoading ? [loading(<p>opening</p>)] : []),
                    ]),
                  ]),
            ],
          ),
        ],
      ),
    ]),
  );
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a parallel slot handler that redirects from an action's revalidation", () => {
  it("answers 204 + X-RSC-Redirect under loading(), as a route handler under loading() does", async () => {
    const acted = await actOnItem(makeRouter({}));
    expect(acted.response.status).toBe(204);
    expect(acted.response.headers.get("X-RSC-Redirect")).toBe(REDIRECT_HEADER);
    expect(acted.flight).toBeUndefined();

    // The route handler under the same loading(), on the same action.
    const routeRouter = makeRouter({ onRoute: true });
    const routeActed = await actOnItem(routeRouter);
    expect(routeActed.response.status).toBe(acted.response.status);
    expect(routeActed.response.headers.get("X-RSC-Redirect")).toBe(
      acted.response.headers.get("X-RSC-Redirect"),
    );
  });

  it("answers 204 when the handler returns the redirect instead of throwing it", async () => {
    const acted = await actOnItem(makeRouter({ produces: "returns" }));
    expect(acted.response.status).toBe(204);
    expect(acted.response.headers.get("X-RSC-Redirect")).toBe(REDIRECT_HEADER);
    expect(acted.flight).toBeUndefined();

    const routeRouter = makeRouter({ onRoute: true, produces: "returns" });
    const routeActed = await actOnItem(routeRouter);
    expect(routeActed.response.status).toBe(acted.response.status);
    expect(routeActed.response.headers.get("X-RSC-Redirect")).toBe(
      acted.response.headers.get("X-RSC-Redirect"),
    );
  });

  it("control: without loading() the returned redirect already redirects", async () => {
    const acted = await actOnItem(
      makeRouter({ produces: "returns", declareLoading: false }),
    );
    expect(acted.response.status).toBe(204);
    expect(acted.response.headers.get("X-RSC-Redirect")).toBe(REDIRECT_HEADER);
  });

  it("answers a handler error with the status a route handler under loading() does", async () => {
    const failing = async (ctx: HandlerCtx): Promise<React.ReactNode> => {
      if (isActionRequest(ctx)) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw new Error("slot handler failed");
      }
      return <aside>slot</aside>;
    };
    const acted = await actOnItem(
      makeRouter({ slotHandler: failing, errorBoundary: true }),
    );
    // Awaited before the status is committed, as the route handler's is: the
    // slot renders the boundary and the answer is a 500, not a 200 whose
    // streamed rejection arrives after the flush.
    expect(acted.response.status).toBe(500);

    const routeRouter = makeRouter({
      onRoute: true,
      slotHandler: failing,
      errorBoundary: true,
    });
    const routeActed = await actOnItem(routeRouter);
    expect(routeActed.response.status).toBe(acted.response.status);
  });

  it("renders the slot from the awaited handler when the action does not redirect", async () => {
    const acted = await actOnItem(makeRouter({ slotHandler: plainHandler }));
    expect(acted.response.status).toBe(200);
    // Awaited, so the segment carries the node the handler returned.
    const slot = slotOf(await metadataOf(acted));
    expect(React.isValidElement(slot?.component)).toBe(true);
  });

  it("still streams the handler on a navigation, as a route handler under loading() does", async () => {
    const router = makeRouter({});
    const opened = await metadataOf(
      await serveShellRequest(router, "/item", {
        partial: { from: "/page", segments: [] },
      }),
    );
    // Not awaited: the browser shows the slot's loading() fallback until it
    // resolves.
    expect(slotOf(opened)?.component).toBeInstanceOf(Promise);
    expect(React.isValidElement(slotOf(opened)?.loading)).toBe(true);

    const routeRouter = makeRouter({ onRoute: true });
    const routeOpened = await metadataOf(
      await serveShellRequest(routeRouter, "/item", {
        partial: { from: "/page", segments: [] },
      }),
    );
    expect(routeOf(routeOpened)?.component).toBeInstanceOf(Promise);
  });

  it("follows a redirect a slot handler without loading() returns on a navigation", async () => {
    const acted = await serveShellRequest(
      makeRouter({
        slotHandler: alwaysRedirecting,
        declareLoading: false,
      }),
      "/item",
      { partial: { from: "/page", segments: [] } },
    );
    expect(acted.response.status).toBe(204);
    expect(acted.response.headers.get("X-RSC-Redirect")).toBe(REDIRECT_HEADER);

    // The route handler without loading(), on the same navigation.
    const routeActed = await serveShellRequest(
      makeRouter({
        onRoute: true,
        slotHandler: alwaysRedirecting,
        declareLoading: false,
      }),
      "/item",
      { partial: { from: "/page", segments: [] } },
    );
    expect(routeActed.response.status).toBe(acted.response.status);
    expect(routeActed.response.headers.get("X-RSC-Redirect")).toBe(
      acted.response.headers.get("X-RSC-Redirect"),
    );
  });
});
