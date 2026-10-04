/**
 * Pins the alternative intercept() points to when it rejects an
 * intercept-level errorBoundary()/notFoundBoundary() (see intercept() in
 * route-definition/dsl-helpers.ts): errors and notFound() from the
 * intercept's loaders render the declaring layout's boundaries, not the
 * intercepted route's, through the real matchPartial pipeline.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { notFound } from "../../errors.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";

const Layout = () => <div>layout</div>;
const LayoutError = <div>layout-error</div>;
const LayoutNotFound = <div>layout-not-found</div>;
const RouteError = <div>route-error</div>;
const RouteNotFound = <div>route-not-found</div>;

const ThrowingLoader = (createLoader as Function)(
  async () => {
    throw new Error("modal loader failed");
  },
  undefined,
  "test#InterceptThrowingLoader",
);
const NotFoundLoader = (createLoader as Function)(
  async () => notFound("no such item"),
  undefined,
  "test#InterceptNotFoundLoader",
);

let router: any;

beforeAll(async () => {
  router = createRouter({} as any);
  router.routes(
    ({
      layout,
      path,
      intercept,
      errorBoundary,
      notFoundBoundary,
      loader,
    }: any) => [
      layout(Layout, () => [
        errorBoundary(LayoutError),
        notFoundBoundary(LayoutNotFound),
        path("/", <div>home</div>, { name: "ilbHome" }),
        // Target routes carry their own boundaries; the intercept does not
        // use them.
        path("/fail/:id", <div>fail</div>, { name: "ilbFail" }, () => [
          errorBoundary(RouteError),
          notFoundBoundary(RouteNotFound),
        ]),
        path("/gone/:id", <div>gone</div>, { name: "ilbGone" }, () => [
          errorBoundary(RouteError),
          notFoundBoundary(RouteNotFound),
        ]),
        intercept("@modal", "ilbFail", <div>modal</div>, () => [
          loader(ThrowingLoader),
        ]),
        intercept("@modal", "ilbGone", <div>modal</div>, () => [
          loader(NotFoundLoader),
        ]),
      ]),
    ],
  );
  await buildRouterTrieFromUrlpatterns(router);
});

async function interceptLoaderResults(pathname: string): Promise<any[]> {
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
  return modal.loaderDataPromise;
}

describe("intercept loader errors resolve against the declaring layout", () => {
  it("a throwing intercept loader renders the enclosing layout's errorBoundary", async () => {
    const [result] = await interceptLoaderResults("/fail/1");
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("modal loader failed");
    expect(result.fallback).toBe(LayoutError);
  });

  it("notFound() in an intercept loader renders the enclosing layout's notFoundBoundary", async () => {
    const [result] = await interceptLoaderResults("/gone/1");
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
    expect(result.fallback).toBe(LayoutNotFound);
  });
});
