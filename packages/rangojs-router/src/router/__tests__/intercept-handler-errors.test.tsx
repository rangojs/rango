/**
 * An intercept handler that throws, or calls notFound(), on a soft navigation
 * renders the declaring layout's errorBoundary / notFoundBoundary inside the
 * modal slot (router/intercept-resolution.ts resolveInterceptEntry), the same
 * way a throwing intercept loader does.
 *
 * Also pinned: a thrown/returned Response propagates, the background cache
 * re-render (skipMiddleware) rejects, and an async handler error under
 * loading() streams as a rejected component (a fallback there would land after
 * the 200 and could be cached).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { notFound } from "../../errors.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { resolveInterceptEntry } from "../intercept-resolution.js";

const Layout = () => <div>layout</div>;
const ModalChrome = () => <div>modal-chrome</div>;
const LayoutError = <div>layout-error</div>;
const LayoutNotFound = <div>layout-not-found</div>;
const RouteError = <div>route-error</div>;

const OkLoader = (createLoader as Function)(
  async () => "ok",
  undefined,
  "test#InterceptHandlerOkLoader",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SlowLoader = (createLoader as Function)(
  async () => {
    await sleep(30);
    return "slow";
  },
  undefined,
  "test#InterceptHandlerSlowLoader",
);

const onError = vi.fn();
let router: any;

beforeAll(async () => {
  router = createRouter({ onError } as any);
  router.routes(
    ({
      layout,
      path,
      intercept,
      errorBoundary,
      notFoundBoundary,
      loader,
      loading,
    }: any) => [
      layout(Layout, () => [
        errorBoundary(LayoutError),
        notFoundBoundary(LayoutNotFound),
        path("/", <div>home</div>, { name: "ihHome" }),
        // Target routes carry their own boundaries; the intercept does not
        // use them.
        ...[
          "Sync",
          "Async",
          "AsyncLoader",
          "SlowLoader",
          "SlowLayout",
          "Gone",
          "AsyncGone",
        ].map((n) =>
          path(
            `/${n.toLowerCase()}/:id`,
            <div>{n}</div>,
            { name: `ih${n}` },
            () => [errorBoundary(RouteError)],
          ),
        ),
        path("/redirect/:id", <div>r</div>, { name: "ihRedirect" }),
        path("/returned/:id", <div>r</div>, { name: "ihReturned" }),
        path("/streamed/:id", <div>s</div>, { name: "ihStreamed" }),
        path("/syncloading/:id", <div>s</div>, { name: "ihSyncLoading" }),
        intercept(
          "@modal",
          "ihSync",
          () => {
            throw new Error("sync modal failed");
          },
          () => [layout(ModalChrome)],
        ),
        intercept("@modal", "ihAsync", async () => {
          await Promise.resolve();
          throw new Error("async modal failed");
        }),
        // Loaders without loading(): the handler promise is awaited after the
        // loaders (second branch in resolveInterceptEntry).
        intercept(
          "@modal",
          "ihAsyncLoader",
          async () => {
            throw new Error("async loader-branch modal failed");
          },
          () => [loader(OkLoader)],
        ),
        // The handler rejects while a loader / an async layout is still pending.
        intercept(
          "@modal",
          "ihSlowLoader",
          async () => {
            throw new Error("modal failed before its loader");
          },
          () => [loader(SlowLoader)],
        ),
        intercept(
          "@modal",
          "ihSlowLayout",
          async () => {
            throw new Error("modal failed before its layout");
          },
          () => [
            layout(async () => {
              await sleep(30);
              return <ModalChrome />;
            }),
          ],
        ),
        intercept("@modal", "ihGone", () => notFound("no such item")),
        intercept("@modal", "ihAsyncGone", async () => notFound("gone async")),
        intercept("@modal", "ihRedirect", () => {
          throw new Response(null, {
            status: 302,
            headers: { Location: "/login" },
          });
        }),
        intercept(
          "@modal",
          "ihReturned",
          async () =>
            new Response(null, { status: 302, headers: { Location: "/x" } }),
        ),
        intercept(
          "@modal",
          "ihStreamed",
          async () => {
            throw new Error("streamed modal failed");
          },
          () => [loading(<div>modal-loading</div>)],
        ),
        intercept(
          "@modal",
          "ihSyncLoading",
          () => {
            throw new Error("sync modal failed under loading");
          },
          () => [loading(<div>modal-loading</div>)],
        ),
      ]),
    ],
  );
  await buildRouterTrieFromUrlpatterns(router);
});

async function navigate(pathname: string) {
  onError.mockClear();
  const request = new Request(`https://example.com${pathname}?_rsc_partial`, {
    headers: {
      accept: "text/x-component",
      "X-RSC-Router-Client-Path": "https://example.com/",
    },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any);
  const result = await runWithRequestContext(reqCtx, () =>
    router.matchPartial(request, { env: {} }),
  );
  const modal = result.segments.find((s: any) => s.slot === "@modal");
  expect(modal).toBeDefined();
  return { result, modal, status: reqCtx.res.status };
}

function expectModalFallback(
  nav: Awaited<ReturnType<typeof navigate>>,
  fallback: unknown,
  status: number,
  message: string,
) {
  const { result, modal } = nav;
  // Same segment shape: a parallel intercept segment, only the component swapped.
  expect(modal.type).toBe("parallel");
  expect(modal.namespace).toMatch(/^intercept:/);
  expect(modal.component).toBe(fallback);
  // The declaring layout is not replaced by an error/notFound segment.
  expect(
    result.segments.filter(
      (s: any) => s.type === "error" || s.type === "notFound",
    ),
  ).toEqual([]);
  expect(nav.status).toBe(status);

  // Reported once as a boundary-handled handler error on the declaring entry.
  const declaringShortCode = modal.id.slice(0, -".@modal".length);
  expect(onError).toHaveBeenCalledTimes(1);
  const [errCtx] = onError.mock.calls[0];
  expect(errCtx).toMatchObject({
    phase: "handler",
    handledByBoundary: true,
    isPartial: true,
    segmentId: declaringShortCode,
  });
  expect(errCtx.error.message).toBe(message);
}

describe("intercept handler errors render the declaring layout's boundary", () => {
  it("sync throw renders the errorBoundary in the modal slot (keeps the intercept layout)", async () => {
    const nav = await navigate("/sync/1");
    expectModalFallback(nav, LayoutError, 500, "sync modal failed");
    expect(nav.modal.layout).toBeDefined();
  });

  it("async (awaited) throw renders the errorBoundary", async () => {
    const nav = await navigate("/async/1");
    expectModalFallback(nav, LayoutError, 500, "async modal failed");
  });

  it("async throw after loaders (no loading()) renders the errorBoundary", async () => {
    const nav = await navigate("/asyncloader/1");
    expectModalFallback(
      nav,
      LayoutError,
      500,
      "async loader-branch modal failed",
    );
    expect(nav.modal.loaderIds).toEqual(["test#InterceptHandlerOkLoader"]);
  });

  // Issue #897: the handler promise is awaited only after the intercept layout
  // and loaders, so a rejection while either was pending went unhandled (a
  // crash under Node's default --unhandled-rejections=throw).
  it.each([
    ["a loader", "/slowloader/1", "modal failed before its loader"],
    ["an async layout", "/slowlayout/1", "modal failed before its layout"],
  ])(
    "an async throw while %s is pending renders the errorBoundary with no unhandledRejection",
    async (_, pathname, message) => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const nav = await navigate(pathname);
        expectModalFallback(nav, LayoutError, 500, message);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      expect(unhandled).toEqual([]);
    },
  );

  it("notFound() renders the notFoundBoundary with a 404", async () => {
    const nav = await navigate("/gone/1");
    expectModalFallback(nav, LayoutNotFound, 404, "no such item");
  });

  it("async notFound() renders the notFoundBoundary with a 404", async () => {
    const nav = await navigate("/asyncgone/1");
    expectModalFallback(nav, LayoutNotFound, 404, "gone async");
  });

  it("a sync throw under loading() is caught too (nothing has streamed yet)", async () => {
    const nav = await navigate("/syncloading/1");
    expectModalFallback(
      nav,
      LayoutError,
      500,
      "sync modal failed under loading",
    );
  });
});

describe("intercept handler lanes left unchanged", () => {
  it.each([
    ["/redirect/1", "/login"],
    ["/returned/1", "/x"],
  ])("a Response from the handler still propagates (%s)", async (p, loc) => {
    await expect(navigate(p)).rejects.toSatisfy(
      (r: unknown) =>
        r instanceof Response && r.headers.get("Location") === loc,
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("an async throw under loading() still streams as a rejected component, reported like a streamed route handler", async () => {
    const nav = await navigate("/streamed/1");
    expect(nav.status).toBe(200);
    expect(nav.modal.component).toBeInstanceOf(Promise);
    await expect(nav.modal.component).rejects.toThrow("streamed modal failed");

    // deps.trackHandler reports the streamed rejection to onError without
    // swallowing it (the client's boundary renders it).
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    const [errCtx] = onError.mock.calls[0];
    expect(errCtx).toMatchObject({
      phase: "handler",
      handledByBoundary: true,
      segmentId: nav.modal.id,
      segmentType: "parallel",
    });
  });

  it("the background re-render (skipMiddleware) still rejects", async () => {
    const parentEntry = {
      type: "layout",
      shortCode: "L9",
      id: "bg-layout",
      parent: null,
      errorBoundary: [LayoutError],
      notFoundBoundary: [],
    } as any;
    const interceptEntry = {
      slotName: "@modal",
      routeName: "bg",
      handler: () => {
        throw new Error("background modal failed");
      },
      middleware: [],
      loader: [],
      when: [],
    } as any;
    const deps = {
      wrapLoaderPromise: vi.fn(),
      trackHandler: vi.fn((p) => p),
      findNearestErrorBoundary: vi.fn(() => LayoutError),
      findNearestNotFoundBoundary: vi.fn(() => null),
      callOnError: vi.fn(),
    } as any;
    const context = {
      request: new Request("https://example.com/bg/1"),
      url: new URL("https://example.com/bg/1"),
      env: {},
      params: {},
      pathname: "/bg/1",
    } as any;
    const reqCtx = createRequestContext({
      env: {},
      request: context.request,
      url: context.url,
      variables: {},
    } as any);

    await expect(
      runWithRequestContext(reqCtx, () =>
        resolveInterceptEntry(
          interceptEntry,
          parentEntry,
          {},
          context,
          true,
          deps,
          undefined,
          { skipMiddleware: true },
        ),
      ),
    ).rejects.toThrow("background modal failed");
    expect(deps.callOnError).not.toHaveBeenCalled();
  });
});
