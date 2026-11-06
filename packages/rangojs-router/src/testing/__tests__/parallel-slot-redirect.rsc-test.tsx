/**
 * A parallel slot handler's redirect() behaves as a route handler's, on every
 * path a slot answers on: the HTTP redirect on a document request, the
 * client-navigation redirect (204 + X-RSC-Redirect) on a partial, prefetch and
 * action-revalidation request, and a render-failed refresh that keeps the
 * stored page on an on-demand prerender.
 *
 * The slot's result used to skip handleHandlerResult
 * (resolveParallelSlotComponent), so a returned Response was rendered into the
 * Flight stream instead of short-circuiting: a document request answered 200
 * with no Location, a partial or action request carried the Response inside
 * its payload, and a refresh failed the whole render with "Only plain objects,
 * and a few built-ins, can be passed to Client Components".
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
import { createMemoryPrerenderStore } from "../index.js";
import { createRouter, Prerender, redirect, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { MemoryPrerenderStore } from "../../prerender/index.js";

const TARGET = "/target";
const PAGE_BODY = "page body";
const STORED_BODY = "stored page body";

/**
 * How a handler answers: a redirect returned synchronously, returned from an
 * async handler, thrown from either, or the page body.
 */
type Answer = "page" | "return" | "return-async" | "throw" | "throw-async";

let slotAnswer: Answer = "page";
let routeAnswer: Answer = "page";

/** The redirect every non-"page" answer resolves to. */
const toTarget = () => redirect(TARGET, 302);

/** A handler that answers with what `answer()` says at call time. */
function answerWith(answer: () => Answer, body: string): () => React.ReactNode {
  return () => {
    switch (answer()) {
      case "return":
        return toTarget() as unknown as React.ReactNode;
      case "return-async":
        return Promise.resolve(
          toTarget() as unknown as React.ReactNode,
        ) as unknown as React.ReactNode;
      case "throw":
        throw toTarget();
      case "throw-async":
        return Promise.reject(toTarget()) as unknown as React.ReactNode;
      case "page":
        return <aside>{body}</aside>;
    }
  };
}

const StoredDef = Prerender(
  async () => [],
  () => <main>{STORED_BODY}</main>,
  { onDemand: true },
);

/** Every kind of owner a slot can hang off. */
type Owner = "route" | "layout" | "orphan" | "cache";

interface Shape {
  owner?: Owner;
  /** The route whose slot answers: the navigation's destination or the page an action revalidates. */
  slotOn?: "plain" | "page";
  /** The slot declares loading(): its handler streams unless an action awaits it. */
  slotLoading?: boolean;
  prerender?: { store: MemoryPrerenderStore };
}

function makeRouter({
  owner = "route",
  slotOn = "plain",
  slotLoading = false,
  prerender,
}: Shape = {}) {
  return createRouter(prerender ? { prerender } : {}).routes(
    urls(({ path, cache, layout, loading, parallel }) => {
      // Every definition is created inside its parent's `use` callback: the DSL
      // registers by side effect, so one built outside it belongs to another
      // entry (and the parent it was written under never sees it).
      const slot = () =>
        parallel({ "@aside": answerWith(() => slotAnswer, PAGE_BODY) }, () =>
          slotLoading ? [loading(<p>slot loading</p>)] : [],
        );
      const routes = () => [
        path(
          "/page",
          () => <main>{PAGE_BODY}</main>,
          { name: "page" },
          () => (slotOn === "page" ? [slot()] : []),
        ),
        path(
          "/plain",
          () => <main>{PAGE_BODY}</main>,
          { name: "plain" },
          () =>
            slotOn === "plain" && owner !== "layout" && owner !== "orphan"
              ? [slot()]
              : [],
        ),
        path("/stored", StoredDef, { name: "stored" }, () => [
          parallel({ "@aside": answerWith(() => slotAnswer, STORED_BODY) }),
        ]),
        path(TARGET, () => <main>target body</main>, { name: "target" }),
      ];
      if (owner === "cache") {
        return [cache({ ttl: 600 }, () => [routes()])];
      }
      return [
        layout(
          () => <div>shell</div>,
          () => [
            ...(owner === "layout" ? [slot()] : []),
            ...(owner === "orphan"
              ? [
                  layout(
                    () => <section>orphan body</section>,
                    () => [slot()],
                  ),
                ]
              : []),
            ...routes(),
          ],
        ),
      ];
    }),
  );
}

/**
 * The same tree with the redirect on a route handler, not a slot: `answering`
 * names the route that carries it (the navigation's destination, or the page
 * an action revalidates).
 */
function makeRouteRouter(
  answering: "plain" | "page" = "plain",
  loading = false,
) {
  const answer = answerWith(() => routeAnswer, PAGE_BODY);
  const page = () => <main>{PAGE_BODY}</main>;
  return createRouter({}).routes(
    urls(({ path, loading: loadingBoundary }) => [
      path(
        "/page",
        answering === "page" ? answer : page,
        { name: "page" },
        () => (loading ? [loadingBoundary(<p>route loading</p>)] : []),
      ),
      path(
        "/plain",
        answering === "plain" ? answer : page,
        { name: "plain" },
        () => (loading ? [loadingBoundary(<p>route loading</p>)] : []),
      ),
      path(TARGET, () => <main>target body</main>, { name: "target" }),
    ]),
  );
}

type Router =
  | ReturnType<typeof makeRouter>
  | ReturnType<typeof makeRouteRouter>;

/** A document request's redirect: the Response itself. */
function expectDocumentRedirect(result: ServeShellRequestResult): void {
  expect(result.response.status).toBe(302);
  expect(result.response.headers.get("location")).toBe(TARGET);
}

/**
 * A redirect on the Flight channel (a client navigation, a prefetch, an
 * action's revalidation): 204 + the header, resolved against the origin.
 */
function expectFlightRedirect(result: ServeShellRequestResult): void {
  expect(result.response.status).toBe(204);
  expect(result.response.headers.get("x-rsc-redirect")).toMatch(
    new RegExp(`${TARGET}$`),
  );
  expect(result.flight).toBeUndefined();
}

async function matchedOf(result: ServeShellRequestResult): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(result.flight!);
  return metadata.matched;
}

/** Show `/page` as a document, so the client holds its segments. */
async function showPage(router: Router): Promise<string[]> {
  return matchedOf(await serveShellRequest(router, "/page"));
}

/** Serve `/plain` as a client navigation from `/page`. */
function navigate(
  router: Router,
  segments: readonly string[],
  prefetch = false,
): Promise<ServeShellRequestResult> {
  return serveShellRequest(router, "/plain", {
    cacheStore: new MemorySegmentCacheStore(),
    partial: {
      from: "/page",
      segments,
      ...(prefetch ? { prefetch: true } : {}),
    },
  });
}

/**
 * Call `save` from `/page`, whose revalidation re-renders it. The page is
 * shown before `flip`, so the slot only redirects during the revalidation.
 */
async function runAction(
  router: Router,
  flip: () => void,
): Promise<ServeShellRequestResult> {
  const cacheStore = new MemorySegmentCacheStore();
  const segments = await matchedOf(
    await serveShellRequest(router, "/page", { cacheStore }),
  );
  flip();
  return serveShellRequest(router, "/page", {
    cacheStore,
    action: { ref: save, id: "actions.ts#save", segments },
  });
}

/** The action the revalidation rows call; its own answer is not the point. */
async function save(): Promise<string> {
  return "saved";
}

const ANSWERS = ["return", "return-async", "throw", "throw-async"] as const;

describe("a parallel slot handler's redirect", () => {
  beforeEach(async () => {
    await resetShellTestState();
    slotAnswer = "page";
    routeAnswer = "page";
  });

  describe("on a document request", () => {
    for (const answer of ANSWERS) {
      it(`is the HTTP redirect (${answer})`, async () => {
        slotAnswer = answer;
        expectDocumentRedirect(await serveShellRequest(makeRouter(), "/plain"));
      });
    }

    it("is the HTTP redirect from every kind of slot owner", async () => {
      slotAnswer = "return";
      for (const owner of ["route", "layout", "orphan", "cache"] as const) {
        expectDocumentRedirect(
          await serveShellRequest(makeRouter({ owner }), "/plain"),
        );
      }
    });
  });

  describe("on the Flight channel", () => {
    for (const answer of ANSWERS) {
      it(`is the client-navigation redirect (${answer})`, async () => {
        slotAnswer = answer;
        const router = makeRouter();
        expectFlightRedirect(await navigate(router, await showPage(router)));
      });
    }

    it("is the client-navigation redirect from a cache() route's slot", async () => {
      const router = makeRouter({ owner: "cache" });
      const segments = await showPage(router);
      slotAnswer = "return";
      expectFlightRedirect(await navigate(router, segments));
    });

    it("is the prefetch's redirect, as the route handler's is", async () => {
      slotAnswer = "return";
      const slotRouter = makeRouter();
      const slotSegments = await showPage(slotRouter);
      routeAnswer = "return";
      const routeRouter = makeRouteRouter();
      const routeSegments = await showPage(routeRouter);

      const viaSlot = await navigate(slotRouter, slotSegments, true);
      const viaRoute = await navigate(routeRouter, routeSegments, true);
      expectFlightRedirect(viaRoute);
      expectFlightRedirect(viaSlot);
      expect(viaSlot.response.headers.get("x-rsc-redirect")).toBe(
        viaRoute.response.headers.get("x-rsc-redirect"),
      );
    });

    it("is the action revalidation's redirect, as the route handler's is", async () => {
      const viaSlot = await runAction(makeRouter({ slotOn: "page" }), () => {
        slotAnswer = "return";
      });
      const viaRoute = await runAction(makeRouteRouter("page"), () => {
        routeAnswer = "return";
      });
      expectFlightRedirect(viaRoute);
      expectFlightRedirect(viaSlot);
      expect(viaSlot.response.headers.get("x-rsc-redirect")).toBe(
        viaRoute.response.headers.get("x-rsc-redirect"),
      );
    });

    it("matches the route handler's status and Location on both channels", async () => {
      slotAnswer = "return";
      routeAnswer = "return";
      const slotRouter = makeRouter();
      const routeRouter = makeRouteRouter();
      const slotDocument = await serveShellRequest(slotRouter, "/plain");
      const routeDocument = await serveShellRequest(routeRouter, "/plain");
      expectDocumentRedirect(routeDocument);
      expect(slotDocument.response.status).toBe(routeDocument.response.status);
      expect(slotDocument.response.headers.get("location")).toBe(
        routeDocument.response.headers.get("location"),
      );
    });
  });

  describe("on an on-demand prerender refresh", () => {
    it("fails the refresh and keeps the stored page, never storing the redirect", async () => {
      const store = createMemoryPrerenderStore();
      const router = makeRouter({ prerender: { store } });

      const first = await router.prerender({ env: {} })("/stored");
      expect(first).toMatchObject({ ok: true, status: "rendered" });
      const stored = store.size;
      expect(stored).toBe(1);

      slotAnswer = "return";
      const refresh = await router.prerender({ env: {} })("/stored");
      expect(refresh).toMatchObject({ ok: false, status: "render-failed" });
      const error = (refresh as { error?: unknown }).error;
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(302);
      expect((error as Response).headers.get("location")).toBe(TARGET);

      // The redirect is never stored: the page stored before keeps serving.
      expect(store.size).toBe(stored);
      const served = await serveShellRequest(router, "/stored");
      expect(served.response.status).toBe(200);
      expect(served.flight).toContain(STORED_BODY);
    });
  });

  describe("a slot that declares loading()", () => {
    // A route handler under loading() streams unless an action awaits it: a
    // Response that arrives after the boundary took over is rendered, not
    // followed (warnOnStreamedResponse documents it). The slot answers exactly
    // as the route does on every channel; each row below is one of those
    // channels, and the sync return is the row a raw slot result broke.
    it("streams the Response, as a route handler under loading() does", async () => {
      slotAnswer = "return-async";
      routeAnswer = "return-async";
      const viaSlot = await serveShellRequest(
        makeRouter({ slotLoading: true }),
        "/plain",
      );
      const viaRoute = await serveShellRequest(
        makeRouteRouter("plain", true),
        "/plain",
      );

      expect(viaSlot.response.status).toBe(viaRoute.response.status);
      expect(viaSlot.response.headers.get("location")).toBe(
        viaRoute.response.headers.get("location"),
      );
      expect(viaSlot.body).toContain("slot loading");
    });

    it("is the HTTP redirect (sync return), as a route handler's is", async () => {
      slotAnswer = "return";
      routeAnswer = "return";
      const viaSlot = await serveShellRequest(
        makeRouter({ slotLoading: true }),
        "/plain",
      );
      const viaRoute = await serveShellRequest(
        makeRouteRouter("plain", true),
        "/plain",
      );

      expectDocumentRedirect(viaRoute);
      expectDocumentRedirect(viaSlot);
    });

    it("is the client-navigation redirect (sync return), as a route handler's is", async () => {
      slotAnswer = "page";
      routeAnswer = "page";
      const slotRouter = makeRouter({ slotLoading: true });
      const routeRouter = makeRouteRouter("plain", true);
      const slotSegments = await matchedOf(
        await serveShellRequest(slotRouter, TARGET),
      );
      const routeSegments = await matchedOf(
        await serveShellRequest(routeRouter, TARGET),
      );
      slotAnswer = "return";
      routeAnswer = "return";

      const viaSlot = await serveShellRequest(slotRouter, "/plain", {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from: TARGET, segments: slotSegments },
      });
      const viaRoute = await serveShellRequest(routeRouter, "/plain", {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from: TARGET, segments: routeSegments },
      });

      expectFlightRedirect(viaRoute);
      expectFlightRedirect(viaSlot);
      expect(viaSlot.response.headers.get("x-rsc-redirect")).toBe(
        viaRoute.response.headers.get("x-rsc-redirect"),
      );
    });

    for (const answer of ANSWERS) {
      it(`is the action revalidation's redirect (${answer}), as a route handler's is`, async () => {
        const viaSlot = await runAction(
          makeRouter({ slotOn: "page", slotLoading: true }),
          () => {
            slotAnswer = answer;
          },
        );
        const viaRoute = await runAction(
          makeRouteRouter("page", true),
          () => {
            routeAnswer = answer;
          },
        );

        expectFlightRedirect(viaRoute);
        expectFlightRedirect(viaSlot);
        expect(viaSlot.response.headers.get("x-rsc-redirect")).toBe(
          viaRoute.response.headers.get("x-rsc-redirect"),
        );
      });
    }
  });
});
