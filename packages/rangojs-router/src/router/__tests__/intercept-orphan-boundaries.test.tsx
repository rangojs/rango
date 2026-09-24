/**
 * An intercept declared inside a routeless (orphan) layout resolves its
 * handler and loader errors against that layout's boundaries, then the
 * boundaries of the layout that holds it in layout[] and that layout's
 * ancestors. The orphan's parent pointer is null (attachOrphanSibling in
 * route-definition/dsl-helpers.ts), so the boundary walk continues through
 * EntryData.orphanOwner (router/error-handling.ts).
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

const Root = () => <div>root</div>;
const ModalHost = () => <div>modal-host</div>;
const OwnHost = () => <div>own-host</div>;
const RootError = <div>root-error</div>;
const RootNotFound = <div>root-not-found</div>;
const HostError = <div>host-error</div>;
const RouteError = <div>route-error</div>;

const ThrowingLoader = (createLoader as Function)(
  async () => {
    throw new Error("orphan modal loader failed");
  },
  undefined,
  "test#OrphanInterceptThrowingLoader",
);
const NotFoundLoader = (createLoader as Function)(
  async () => notFound("orphan loader gone"),
  undefined,
  "test#OrphanInterceptNotFoundLoader",
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
    }: any) => [
      layout(Root, () => [
        errorBoundary(RootError),
        notFoundBoundary(RootNotFound),
        path("/", <div>home</div>, { name: "iobHome" }),
        // Target routes carry their own boundaries; the intercept does not
        // use them.
        ...["Throw", "Gone", "LoaderThrow", "LoaderGone", "Own"].map((n) =>
          path(
            `/${n.toLowerCase()}/:id`,
            <div>{n}</div>,
            { name: `iob${n}` },
            () => [errorBoundary(RouteError)],
          ),
        ),
        // Routeless modal host with no boundary of its own.
        layout(ModalHost, () => [
          intercept("@modal", "iobThrow", () => {
            throw new Error("orphan modal failed");
          }),
          intercept("@modal", "iobGone", () => notFound("orphan modal gone")),
          intercept("@modal", "iobLoaderThrow", <div>modal</div>, () => [
            loader(ThrowingLoader),
          ]),
          intercept("@modal", "iobLoaderGone", <div>modal</div>, () => [
            loader(NotFoundLoader),
          ]),
        ]),
        // Routeless modal host with its own boundary: it still wins.
        layout(OwnHost, () => [
          errorBoundary(HostError),
          intercept("@modal", "iobOwn", () => {
            throw new Error("own-host modal failed");
          }),
        ]),
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
  return { modal, status: reqCtx.res.status };
}

describe("intercept declared in a routeless layout: ancestor boundaries", () => {
  it("a handler throw renders the root layout's errorBoundary", async () => {
    const { modal, status } = await navigate("/throw/1");
    expect(modal.component).toBe(RootError);
    expect(status).toBe(500);
    // Reported on the declaring (orphan) entry, not the boundary's owner.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      phase: "handler",
      handledByBoundary: true,
      segmentId: modal.id.slice(0, -".@modal".length),
    });
  });

  it("a handler notFound() renders the root layout's notFoundBoundary", async () => {
    const { modal, status } = await navigate("/gone/1");
    expect(modal.component).toBe(RootNotFound);
    expect(status).toBe(404);
  });

  it("a throwing loader renders the root layout's errorBoundary", async () => {
    const { modal } = await navigate("/loaderthrow/1");
    const [result] = await modal.loaderDataPromise;
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("orphan modal loader failed");
    expect(result.fallback).toBe(RootError);
  });

  it("a loader notFound() renders the root layout's notFoundBoundary", async () => {
    const { modal } = await navigate("/loadergone/1");
    const [result] = await modal.loaderDataPromise;
    expect(result.notFound).toBe(true);
    expect(result.fallback).toBe(RootNotFound);
  });

  it("the routeless layout's own errorBoundary still wins", async () => {
    const { modal, status } = await navigate("/own/1");
    expect(modal.component).toBe(HostError);
    expect(status).toBe(500);
  });
});

describe("routeless layout's own loader: same boundary walk", () => {
  const WrapperLoader = (createLoader as Function)(
    async () => {
      throw new Error("wrapper loader failed");
    },
    undefined,
    "test#OrphanWrapperThrowingLoader",
  );

  it("a throwing loader on a routeless layout renders the root layout's errorBoundary", async () => {
    const wrapperRouter: any = createRouter({} as any);
    wrapperRouter.routes(({ layout, path, errorBoundary, loader }: any) => [
      layout(Root, () => [
        errorBoundary(RootError),
        layout(ModalHost, () => [loader(WrapperLoader)]),
        path("/", <div>home</div>, { name: "iobWrapperHome" }),
        path("/b", <div>b</div>, { name: "iobWrapperB" }),
      ]),
    ]);
    await buildRouterTrieFromUrlpatterns(wrapperRouter);
    const request = new Request("https://example.com/b?_rsc_partial", {
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
      wrapperRouter.matchPartial(request, { env: {} }),
    );
    const loaderSegment = result.segments.find(
      (s: any) => s.loaderId === "test#OrphanWrapperThrowingLoader",
    );
    const data = await loaderSegment.loaderData;
    expect(data.ok).toBe(false);
    expect(data.fallback).toBe(RootError);
  });
});
