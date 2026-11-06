/**
 * An intercept whose handler declares loading() and returns redirect() from an
 * async handler, resolved by an action's revalidation, answers as a route
 * handler under loading() does: 204 with X-RSC-Redirect, not a 200 whose
 * Flight payload carries the Response.
 *
 * resolveInterceptEntry streamed a handler under the slot's loading() whenever
 * the handler was async, action or not. An action awaits the handlers its
 * revalidation re-renders (segment-resolution/revalidation.ts
 * resolveRouteComponent), so a thrown Response short-circuits the request; the
 * streamed intercept put the Response in the payload instead, and the browser
 * kept the page while the slot failed to render.
 *
 * The same intercept still streams on a navigation, where a route handler
 * under loading() streams too: the slot's loading() fallback is its own
 * contract, and only the action awaits.
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

/**
 * The handler every router here uses: the modal on the navigation that opens
 * it, a redirect on the action's revalidation. Async, so it streams under
 * loading().
 */
async function handler(ctx: HandlerCtx): Promise<React.ReactNode> {
  if (isActionRequest(ctx)) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return redirect(REDIRECT_TO);
  }
  return <dialog>modal</dialog>;
}

/** The same redirect, returned synchronously. */
function syncHandler(ctx: HandlerCtx): React.ReactNode {
  return isActionRequest(ctx) ? redirect(REDIRECT_TO) : <dialog>modal</dialog>;
}

/** An async handler that renders instead of redirecting. */
async function plainHandler(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return <dialog>modal</dialog>;
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
  return metadata.segments.find((s) => s.slot === "@modal");
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
    id: `src/intercept.actions.ts#touch${++actionSeq}`,
    segments,
  };
}

/** The /page page as the browser holds it. */
async function pageSegments(router: Router): Promise<readonly string[]> {
  return (
    await metadataOf(
      await serveShellRequest(router, "/page", { partial: true }),
    )
  ).matched;
}

/** The /target page as the browser holds it, opened from /page. */
async function targetSegments(
  router: Router,
  from: readonly string[],
): Promise<readonly string[]> {
  return (
    await metadataOf(
      await serveShellRequest(router, "/target", {
        partial: { from: "/page", segments: from },
      }),
    )
  ).matched;
}

/**
 * Open `@modal` over /target from /page, then call an action from the page
 * that opened it, as the browser sends it: the held segment ids and the
 * intercept source.
 */
async function openThenAct(
  router: Router,
  segments?: readonly string[],
): Promise<ServeShellRequestResult> {
  const held =
    segments ?? (await targetSegments(router, await pageSegments(router)));
  return serveShellRequest(router, "/target", {
    headers: { "X-RSC-Router-Intercept-Source": "/page" },
    action: actionOf(held),
  });
}

type Router = ReturnType<typeof makeRouter>;

/**
 * A router with /page and /target, where the handler and its loading()
 * declaration sit on `@modal` (intercepting /target) or, with `onRoute`, on
 * /target's own route.
 */
function makeRouter(options: {
  interceptHandler?: (
    ctx: HandlerCtx,
  ) => React.ReactNode | Promise<React.ReactNode>;
  declareLoading?: boolean;
  /** Put the handler and its loading() on /target's route instead. */
  onRoute?: boolean;
  routeHandler?: (
    ctx: HandlerCtx,
  ) => React.ReactNode | Promise<React.ReactNode>;
}) {
  const {
    interceptHandler = handler,
    declareLoading = true,
    onRoute = false,
    routeHandler = handler,
  } = options;
  return createRouter({}).routes(
    urls(({ path, layout, intercept, loading }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/page", () => <p>page</p>, { name: "page" }),
          onRoute
            ? path(
                "/target",
                routeHandler,
                { name: "target" },
                declareLoading ? () => [loading(<p>opening</p>)] : undefined,
              )
            : path("/target", () => <article>target</article>, {
                name: "target",
              }),
          ...(onRoute
            ? []
            : [
                intercept(
                  "@modal",
                  ".target",
                  interceptHandler,
                  declareLoading ? () => [loading(<p>opening</p>)] : undefined,
                ),
              ]),
        ],
      ),
    ]),
  );
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("an intercept handler that redirects from an action's revalidation", () => {
  it("answers 204 + X-RSC-Redirect under loading(), as a route handler under loading() does", async () => {
    const acted = await openThenAct(makeRouter({}));
    expect(acted.response.status).toBe(204);
    expect(acted.response.headers.get("X-RSC-Redirect")).toBe(REDIRECT_HEADER);
    expect(acted.flight).toBeUndefined();

    // The route handler under the same loading(), on the same action.
    const routeRouter = makeRouter({ onRoute: true });
    const routeActed = await openThenAct(
      routeRouter,
      await pageSegments(routeRouter),
    );
    expect(routeActed.response.status).toBe(acted.response.status);
    expect(routeActed.response.headers.get("X-RSC-Redirect")).toBe(
      acted.response.headers.get("X-RSC-Redirect"),
    );
  });

  it("control: without loading() the async handler already redirects", async () => {
    const acted = await openThenAct(makeRouter({ declareLoading: false }));
    expect(acted.response.status).toBe(204);
    expect(acted.response.headers.get("X-RSC-Redirect")).toBe(REDIRECT_HEADER);
  });

  it("control: a synchronous redirect under loading() already redirects", async () => {
    const acted = await openThenAct(
      makeRouter({ interceptHandler: syncHandler }),
    );
    expect(acted.response.status).toBe(204);
    expect(acted.response.headers.get("X-RSC-Redirect")).toBe(REDIRECT_HEADER);
  });

  it("renders the slot from the awaited handler when the action does not redirect", async () => {
    const acted = await openThenAct(
      makeRouter({ interceptHandler: plainHandler }),
    );
    expect(acted.response.status).toBe(200);
    // Awaited, so the segment carries the node the handler returned.
    const slot = slotOf(await metadataOf(acted));
    expect(React.isValidElement(slot?.component)).toBe(true);
  });

  it("still streams the handler on a navigation, as a route handler under loading() does", async () => {
    const router = makeRouter({});
    const opened = await metadataOf(
      await serveShellRequest(router, "/target", {
        partial: { from: "/page", segments: await pageSegments(router) },
      }),
    );
    // Not awaited: the browser shows the slot's loading() fallback until it
    // resolves.
    expect(slotOf(opened)?.component).toBeInstanceOf(Promise);
    expect(React.isValidElement(slotOf(opened)?.loading)).toBe(true);

    const routeRouter = makeRouter({ onRoute: true });
    const routeOpened = await metadataOf(
      await serveShellRequest(routeRouter, "/target", {
        partial: { from: "/page", segments: await pageSegments(routeRouter) },
      }),
    );
    expect(routeOf(routeOpened)?.component).toBeInstanceOf(Promise);
  });
});
