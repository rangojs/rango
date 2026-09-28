/**
 * errorBoundary(), notFoundBoundary() and intercept() declared in a routeless
 * entry nested in another routeless entry are found by the lookups that scan
 * orphans (issue #926). Two shapes nest an orphan one level deeper:
 * - a layout() after a bare cache() marker, for the routes before the marker
 *   (marker in the layout's layout[], the layout in the marker's layout[]);
 * - a layout() inside a routeless transition() wrapper.
 *
 * Both render since #922. Before this fix the boundary walkers
 * (router/error-handling.ts), matchError (router/match-api.ts), the intercept
 * lookups (router/intercept-resolution.ts) and the prerender intercept scan
 * (router/prerender-match.ts) read one orphan level only.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

// matchForPrerender serializes through @vitejs/plugin-rsc/rsc (a virtual
// module); a fixed stream is enough to count intercept segments.
function pluginRscMock() {
  return {
    createFromReadableStream: vi.fn(),
    renderToReadableStream: vi.fn(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("BAKED"));
            controller.close();
          },
        }),
    ),
    loadServerAction: vi.fn(),
    decodeReply: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createTemporaryReferenceSet: vi.fn(() => ({})),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { createRouter } from "../../router.js";
import { Prerender } from "../../prerender.js";
import { notFound } from "../../errors.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import type { EntryData } from "../../server/context.js";
import { collectInterceptTargetNames } from "../intercept-resolution.js";

const Root = () => <div>root</div>;
const ModalHost = () => <div>modal-host</div>;
const NestedError = <div>nested-error</div>;
const NestedNotFound = <div>nested-not-found</div>;
const Modal = <div>modal</div>;

// "direct" is the one-level control: the layout is an orphan of Root.
type Shape = "direct" | "marker" | "wrapper";

// `nested` is a thunk so a bare marker is registered before the layout.
const nestUnder: Record<Shape, (h: any, nested: () => unknown) => unknown[]> = {
  direct: (_h, nested) => [nested()],
  marker: (h, nested) => [h.cache(), nested()],
  wrapper: (h, nested) => [h.transition(() => [nested()])],
};

async function buildRouter(shape: Shape): Promise<any> {
  const router: any = createRouter({} as any);
  router.routes((h: any) => [
    h.layout(Root, () => [
      h.path("/", <div>home</div>, { name: `${shape}Home` }),
      h.path(
        "/throw",
        () => {
          throw new Error("route failed");
        },
        { name: `${shape}Throw` },
      ),
      h.path("/gone", () => notFound("route gone"), { name: `${shape}Gone` }),
      h.path(
        "/photo/:id",
        Prerender(() => <div>photo</div>),
        { name: `${shape}Photo` },
      ),
      ...nestUnder[shape](h, () =>
        h.layout(ModalHost, () => [
          h.errorBoundary(NestedError),
          h.notFoundBoundary(NestedNotFound),
          h.intercept("@modal", `${shape}Photo`, Modal),
          h.intercept("@modal", `${shape}After`, Modal),
        ]),
      ),
      // After a bare marker this route's chain holds the marker, which is also
      // in Root's layout[]: the scan must not visit the marker's tree twice.
      h.path(
        "/after/:id",
        Prerender(() => <div>after</div>),
        { name: `${shape}After` },
      ),
    ]),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
  return router;
}

function partialRequest(pathname: string): Request {
  return new Request(`https://example.com${pathname}?_rsc_partial`, {
    headers: {
      accept: "text/x-component",
      "X-RSC-Router-Client-Path": "https://example.com/",
    },
  });
}

async function inRequest(
  request: Request,
  fn: () => Promise<any>,
): Promise<{ result: any; status: number }> {
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any);
  const result = await runWithRequestContext(reqCtx, fn);
  return { result, status: reqCtx.res.status };
}

describe.each<Shape>(["direct", "marker", "wrapper"])(
  "a routeless layout's boundaries and intercepts (%s)",
  (shape) => {
    let router: any;
    beforeAll(async () => {
      router = await buildRouter(shape);
    });

    it("a route handler error renders its errorBoundary", async () => {
      const request = partialRequest("/throw");
      const { result, status } = await inRequest(request, () =>
        router.matchPartial(request, { env: {} }),
      );
      const errorSegment = result.segments.find((s: any) => s.type === "error");
      expect(errorSegment?.component).toBe(NestedError);
      expect(status).toBe(500);
    });

    it("a route handler notFound() renders its notFoundBoundary", async () => {
      const request = partialRequest("/gone");
      const { result, status } = await inRequest(request, () =>
        router.matchPartial(request, { env: {} }),
      );
      const segment = result.segments.find(
        (s: any) => s.component === NestedNotFound,
      );
      expect(segment).toBeDefined();
      expect(status).toBe(404);
    });

    it("matchError renders its errorBoundary in the route's position", async () => {
      const home = await inRequest(partialRequest("/"), () =>
        router.matchPartial(partialRequest("/"), { env: {} }),
      );
      const homeRoute = home.result.segments.find(
        (s: any) => s.type === "route",
      );
      const request = new Request("https://example.com/", { method: "POST" });
      const { result } = await inRequest(request, () =>
        router.matchError(request, { env: {} }, new Error("action failed")),
      );
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].component).toBe(NestedError);
      expect(result.segments[0].id).toBe(homeRoute.id);
    });

    it.each(["/photo/1", "/after/1"])(
      "an intercept declared in it is matched (%s)",
      async (pathname) => {
        const request = partialRequest(pathname);
        const { result } = await inRequest(request, () =>
          router.matchPartial(request, { env: {} }),
        );
        const modal = result.segments.filter((s: any) => s.slot === "@modal");
        expect(modal).toHaveLength(1);
        expect(modal[0].component).toBe(Modal);
      },
    );

    it.each(["/photo/1", "/after/1"])(
      "the build pre-renders that intercept once (%s)",
      async (pathname) => {
        const result = await router.matchForPrerender(pathname, { id: "1" });
        expect(result.interceptSegments).toHaveLength(1);
      },
    );
  },
);

// The walk skips the chain entry it came up from. Without that, the marker
// was scanned as a chain entry and again from its layout's layout[].
it("the build pre-renders an intercept declared on a bare marker once", async () => {
  const router: any = createRouter({} as any);
  router.routes((h: any) => [
    h.layout(Root, () => [
      h.path("/", <div>home</div>, { name: "onMarkerHome" }),
      h.cache(),
      h.intercept("@modal", "onMarkerAfter", Modal),
      h.path(
        "/after/:id",
        Prerender(() => <div>after</div>),
        { name: "onMarkerAfter" },
      ),
    ]),
  ]);
  const result = await router.matchForPrerender("/after/1", { id: "1" });
  expect(result.interceptSegments).toHaveLength(1);
});

describe("collectInterceptTargetNames: nested orphans", () => {
  function entry(over: Partial<EntryData>): EntryData {
    return {
      intercept: [],
      layout: [],
      parent: null,
      ...over,
    } as unknown as EntryData;
  }

  it("lists a target declared in a routeless entry's own orphan", () => {
    const nested = entry({ intercept: [{ routeName: "photo" }] as any });
    const marker = entry({ layout: [nested] });
    const root = entry({ layout: [marker] });
    const route = entry({ parent: root });
    expect(collectInterceptTargetNames(route)).toEqual(["photo"]);
  });
});
