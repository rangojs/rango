/**
 * The document hot path's segment walk: one FRESH pass of the segment walker
 * (revalidation.ts resolveAllSegmentsWithRevalidation with freshPassInput)
 * per route of a fixed route set, as match middleware runs it for a full
 * match. Each walk gets its own handler context and loader map, as a request
 * does, so loader memoization never carries over between walks.
 *
 * The route set has the shapes the e2e test-app's documents walk
 * (docs/tree-structure.md): layouts nested four deep, loaders with
 * loading() undefined, false, a fallback and `ssr: false`, a streamed handler,
 * parallel slots with their own loaders, an orphan layout inheriting the
 * route's loaders, a routeless layout after a cache() marker and include().
 * The test-app itself does not load under vitest (clientUrls() and other
 * modules need the Vite plugin's transforms).
 *
 *   ./node_modules/.bin/vitest bench --run src/router/segment-resolution/__tests__/resolve-all.bench.ts
 */
import { beforeAll, bench, describe } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRouter } from "../../../router.js";
import { createLoader } from "../../../loader.rsc.js";
import { urls } from "../../../urls.js";
import { buildRouterTrieFromUrlpatterns } from "../../../rsc/manifest-init.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import { getContext } from "../../../server/context.js";
import {
  getRouterContext,
  runWithRouterContext,
  type RouterContext,
} from "../../router-context.js";
import { resolveRoute, type RouteSnapshot } from "../../route-snapshot.js";
import { freshPassInput } from "../resolution-pass.js";
import type { HandlerContext } from "../../../types.js";

const loaderOf = (id: string, value: unknown) =>
  (createLoader as Function)(async () => value, undefined, `bench#${id}`);
const DataLoader = loaderOf("Data", { value: "data" });
const SlotLoader = loaderOf("Slot", { value: "slot" });
const LevelLoader = loaderOf("Level", { level: true });

const el = (tag: string, text: string): ReactNode =>
  createElement(tag, null, text);
const Spinner = el("i", "spinner");

let routerCtx: RouterContext;

const included = urls(({ path, layout, loader }) => [
  layout(
    () => el("section", "included layout"),
    () => [
      loader(LevelLoader),
      path(
        "/a",
        () => el("p", "a"),
        { name: "a" },
        () => [loader(DataLoader)],
      ),
      path("/b/:id", () => el("p", "b"), { name: "b" }),
    ],
  ),
]);

/** The routes walked, by pathname. */
const PATHS = [
  "/plain",
  "/loading-undefined",
  "/loading-false",
  "/loading-truthy",
  "/ssr-false",
  "/streamed",
  "/parallel",
  "/orphan",
  "/after-marker",
  "/deep/one/two/three",
  "/blog/hello-world",
  "/inc/a",
  "/inc/b/7",
];

const snapshots = new Map<string, RouteSnapshot>();

beforeAll(async () => {
  const router = createRouter({});
  router.routes(
    ({ layout, path, loader, loading, parallel, include, cache }) => [
      layout(
        () => el("div", "root"),
        () => [
          path(
            "/probe",
            () => {
              routerCtx = getRouterContext();
              return null;
            },
            { name: "probe" },
          ),
          path("/plain", () => el("p", "plain"), { name: "plain" }),
          path(
            "/loading-undefined",
            () => el("p", "loading undefined"),
            { name: "loadingUndefined" },
            () => [loader(DataLoader)],
          ),
          path(
            "/loading-false",
            () => el("p", "loading false"),
            { name: "loadingFalse" },
            () => [loader(DataLoader), loader(SlotLoader), loading(false)],
          ),
          path(
            "/loading-truthy",
            () => el("p", "loading truthy"),
            { name: "loadingTruthy" },
            () => [loader(DataLoader), loading(Spinner)],
          ),
          path(
            "/ssr-false",
            () => el("p", "ssr false"),
            { name: "ssrFalse" },
            () => [
              loader(DataLoader, { ssr: false }),
              loader(SlotLoader),
              loading(Spinner),
            ],
          ),
          path(
            "/streamed",
            async () => el("p", "streamed"),
            { name: "streamed" },
            () => [loading(Spinner)],
          ),
          layout(
            () => el("section", "slots"),
            () => [
              parallel({ "@side": () => el("aside", "side") }, () => [
                loader(SlotLoader),
                loading(Spinner),
              ]),
              parallel({
                "@top": async () => el("header", "top"),
                "@bottom": () => el("footer", "bottom"),
              }),
              path("/parallel", () => el("p", "parallel"), {
                name: "parallel",
              }),
            ],
          ),
          path(
            "/orphan",
            () => el("p", "orphan"),
            { name: "orphan" },
            () => [
              loader(DataLoader),
              layout(
                () => el("nav", "orphan layout"),
                () => [parallel({ "@aside": () => el("aside", "aside") })],
              ),
            ],
          ),
          layout(
            () => el("main", "host"),
            () => [
              path("/before-marker", () => el("p", "before"), {
                name: "beforeMarker",
              }),
              cache(),
              layout(() => el("nav", "nested routeless")),
              path("/after-marker", () => el("p", "after"), {
                name: "afterMarker",
              }),
            ],
          ),
          layout(
            () => el("div", "level 1"),
            () => [
              loader(LevelLoader),
              layout(
                () => el("div", "level 2"),
                () => [
                  layout(
                    () => el("div", "level 3"),
                    () => [
                      loader(SlotLoader),
                      layout(
                        () => el("div", "level 4"),
                        () => [
                          path(
                            "/deep/one/two/three",
                            () => el("p", "deep"),
                            { name: "deep" },
                            () => [loader(DataLoader)],
                          ),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
          layout(
            () => el("article", "blog"),
            () => [
              loader(LevelLoader),
              path(
                "/blog/:slug",
                () => el("p", "post"),
                { name: "post" },
                () => [loader(DataLoader), loading(Spinner)],
              ),
            ],
          ),
          include("/inc", included, { name: "inc" }),
        ],
      ),
    ],
  );
  await buildRouterTrieFromUrlpatterns(router);
  const probe = new Request("https://example.com/probe");
  const internal = router as unknown as {
    match(request: Request, input: { env: object }): Promise<unknown>;
  };
  await runWithRequestContext(
    createRequestContext({
      env: {},
      request: probe,
      url: new URL(probe.url),
      variables: {},
    }),
    () => internal.match(probe, { env: {} }),
  );
  await runWithRouterContext(routerCtx, async () => {
    for (const pathname of PATHS) {
      const resolved = await resolveRoute(pathname, {
        findMatch: (p) => routerCtx.findMatch(p),
        isSSR: true,
      });
      if (resolved?.type !== "match") throw new Error(`no route: ${pathname}`);
      snapshots.set(pathname, resolved.snapshot);
    }
  });
});

/** One full match's segment walk. */
function walkFresh(
  snapshot: RouteSnapshot,
  context: HandlerContext<any>,
  pathname: string,
): Promise<unknown> {
  return routerCtx.resolveAllSegmentsWithRevalidation(
    freshPassInput(context, snapshot.routeKey, snapshot.params),
    snapshot.entries,
    { pathname },
  );
}

/** Walk one route in a request of its own, as a document request does. */
function walk(pathname: string): Promise<unknown> {
  const snapshot = snapshots.get(pathname)!;
  const request = new Request(`https://example.com${pathname}`);
  const url = new URL(request.url);
  return runWithRequestContext(
    createRequestContext({ env: {}, request, url, variables: {} }),
    () =>
      runWithRouterContext(routerCtx, () => {
        const context = routerCtx.createHandlerContext(
          snapshot.params,
          request,
          url.searchParams,
          pathname,
          url,
          {},
          {},
          snapshot.routeKey,
          snapshot.responseType,
          false,
        );
        routerCtx.setupLoaderAccess(context, new Map());
        const store = getContext().getOrCreateStore(snapshot.routeKey);
        return getContext().runWithStore(
          store,
          store.namespace || "#router",
          store.parent,
          () => walkFresh(snapshot, context, pathname),
        );
      }),
  );
}

describe("segment walk, full match (FRESH pass)", () => {
  bench(`resolveAll over ${PATHS.length} routes`, async () => {
    for (const pathname of PATHS) await walk(pathname);
  });
});
