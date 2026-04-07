import { urls, cookies, createVar } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import {
  MwChainLoader,
  MwChainParallelLoader,
  MwChainInterceptLoader,
} from "../loaders.js";
import {
  MwChainClientDisplay,
  MwChainParallelClientDisplay,
  MwChainInterceptClientDisplay,
} from "../components/MwChainDisplay.js";
import { MwChainActionButton } from "../components/MwChainActionButton.js";
import { mwChainFormAction } from "../actions.js";

// Route-scoped typed variables (only used within this url tree)
const ChainRoute = createVar<string>();
const LayoutData = createVar<string>();
const HandlerData = createVar<string>();

/**
 * Middleware chain integration test.
 *
 * The full chain being tested:
 *   global middleware (router.use) -> action -> route middleware (urls) -> layout -> handler -> loaders
 *
 * Also tests:
 *   - Parent loader inheritance: MwChainLoader on layout, inherited by path and parallel
 *   - Orphan layouts: pathless layouts with parallels at two levels:
 *     1. Top-level orphan (sibling to path inside main layout)
 *     2. Nested orphan (inside index path's children)
 *     Both inherit the layout loader and see middleware context.
 *   - Handler-first execution: main layout ctx.set -> path handler ctx.set ->
 *     orphan layout ctx.get. The orphan wraps the handler in the render tree
 *     but executes after it, proving data set by the handler is available to
 *     its wrapping orphan layout.
 *   - Intercept chain: global mw -> route mw -> intercept mw -> intercept handler -> intercept loader
 *
 * Each layer sets context variables, response headers, and cookies.
 * The test verifies all values propagate correctly through the chain,
 * including after a server action mutates state mid-request.
 */
export const mwChainPatterns = urls(
  ({
    path,
    layout,
    middleware,
    loader,
    parallel,
    revalidate,
    intercept,
    when,
  }) => [
    // Route middleware: verifies upstream state, sets route-level state.
    // After the refactor this wraps RENDERING only — actions already ran.
    middleware(async (ctx, next) => {
      const globalVar = ctx.get("chainGlobal") as string | undefined;
      const actionCookie = cookies().get("chain-action")?.value ?? null;

      // Record what route middleware observed (for test verification)
      ctx.set(
        "chainRouteReport",
        JSON.stringify({
          sawGlobalVar: globalVar ?? null,
          sawActionCookie: actionCookie,
        }),
      );

      ctx.set(ChainRoute, "from-route-mw");
      ctx.header("X-Chain-Route", "applied");
      cookies().set("chain-route", "rv", { path: "/", maxAge: 86400 });
      await next();
    }),

    // Layout: sets LayoutData for downstream consumers, reads vars from every layer.
    // Handler-first: this layout runs before the path handler, so the path
    // handler and its orphan layout children can both read LayoutData.
    layout(
      async (ctx) => {
        ctx.set(LayoutData, "from-main-layout");

        const globalVar = ctx.get("chainGlobal") as string | undefined;
        const actionVar = ctx.get("chainAction") as string | undefined;
        const routeVar = ctx.get(ChainRoute);

        return (
          <div data-testid="mw-chain-layout">
            <span data-testid="layout-global-var">{globalVar ?? "none"}</span>
            <span data-testid="layout-action-var">{actionVar ?? "none"}</span>
            <span data-testid="layout-route-var">{routeVar ?? "none"}</span>
            <Outlet />
            <ParallelOutlet name="@panel" />
            <ParallelOutlet name="@modal" />
          </div>
        );
      },
      () => [
        // Revalidate layout after actions so it picks up fresh ctx vars
        revalidate(() => true),

        // Loader on layout — inherited by path, parallel, AND orphan layouts
        loader(MwChainLoader),

        // Orphan layout: pathless wrapper with its own parallel.
        // Tests that middleware context, loader inheritance, and LayoutData
        // propagate through an intermediate layout that has no URL routes.
        layout(
          (ctx) => {
            const layoutData = ctx.get(LayoutData);
            return (
              <div data-testid="mw-chain-orphan-layout">
                <span data-testid="orphan-layout-data">
                  {layoutData ?? "none"}
                </span>
                <Outlet />
                <ParallelOutlet name="@orphan-panel" />
              </div>
            );
          },
          () => [
            parallel({
              "@orphan-panel": (ctx) => {
                const layoutData = ctx.get(LayoutData);
                const handlerData = ctx.get(HandlerData);
                return (
                  <div data-testid="mw-chain-orphan-parallel">
                    <span data-testid="orphan-parallel-layout-data">
                      {layoutData ?? "none"}
                    </span>
                    <span data-testid="orphan-parallel-handler-data">
                      {handlerData ?? "none"}
                    </span>
                    <MwChainClientDisplay
                      loader={MwChainLoader}
                      testIdPrefix="orphan-inherited"
                    />
                  </div>
                );
              },
            }),
          ],
        ),

        // Index handler: sets HandlerData, reads all vars including LayoutData
        // from parent layout. Handler-first: runs BEFORE its orphan layout
        // children, so orphan layouts can read HandlerData.
        path(
          "/",
          async (ctx) => {
            ctx.set(HandlerData, "from-handler");

            const globalVar = ctx.get("chainGlobal") as string | undefined;
            const actionVar = ctx.get("chainAction") as string | undefined;
            const routeVar = ctx.get(ChainRoute);
            const layoutData = ctx.get(LayoutData);
            const routeReport = ctx.get("chainRouteReport") as
              | string
              | undefined;

            return (
              <div data-testid="mw-chain-page">
                <span data-testid="handler-global-var">
                  {globalVar ?? "none"}
                </span>
                <span data-testid="handler-action-var">
                  {actionVar ?? "none"}
                </span>
                <span data-testid="handler-route-var">
                  {routeVar ?? "none"}
                </span>
                <span data-testid="handler-layout-data">
                  {layoutData ?? "none"}
                </span>
                <span data-testid="handler-route-report">
                  {routeReport ?? "none"}
                </span>
                <MwChainActionButton />
                <form action={mwChainFormAction} data-testid="chain-pe-form">
                  <button type="submit" data-testid="chain-pe-submit">
                    PE Action
                  </button>
                </form>
                <MwChainClientDisplay loader={MwChainLoader} />
                <Link
                  to="/mw-chain/detail/test-slug"
                  data-testid="chain-detail-link"
                >
                  Detail
                </Link>
              </div>
            );
          },
          { name: "index" },
          () => [
            // Orphan layout inside path: wraps handler content.
            // Handler-first proof: this layout wraps the path handler in
            // the render tree, yet runs AFTER it. It can read HandlerData
            // set by the path handler + LayoutData from the parent layout.
            layout(
              (ctx) => {
                const layoutData = ctx.get(LayoutData);
                const handlerData = ctx.get(HandlerData);
                return (
                  <div data-testid="mw-chain-sub-orphan-layout">
                    <span data-testid="sub-orphan-layout-data">
                      {layoutData ?? "none"}
                    </span>
                    <span data-testid="sub-orphan-handler-data">
                      {handlerData ?? "none"}
                    </span>
                    <Outlet />
                    <ParallelOutlet name="@sub-panel" />
                  </div>
                );
              },
              () => [
                parallel({
                  "@sub-panel": (ctx) => {
                    const layoutData = ctx.get(LayoutData);
                    const handlerData = ctx.get(HandlerData);
                    return (
                      <div data-testid="mw-chain-sub-parallel">
                        <span data-testid="sub-parallel-layout-data">
                          {layoutData ?? "none"}
                        </span>
                        <span data-testid="sub-parallel-handler-data">
                          {handlerData ?? "none"}
                        </span>
                        <MwChainClientDisplay
                          loader={MwChainLoader}
                          testIdPrefix="sub-inherited"
                        />
                      </div>
                    );
                  },
                }),
              ],
            ),
          ],
        ),

        // Detail handler: target for intercept, also serves direct navigation
        path(
          "/detail/:slug",
          async (ctx) => {
            const globalVar = ctx.get("chainGlobal") as string | undefined;
            const routeVar = ctx.get(ChainRoute);

            return (
              <div data-testid="mw-chain-detail-page">
                <span data-testid="detail-global-var">
                  {globalVar ?? "none"}
                </span>
                <span data-testid="detail-route-var">{routeVar ?? "none"}</span>
                <span data-testid="detail-slug">{ctx.params.slug}</span>
                <MwChainClientDisplay
                  loader={MwChainLoader}
                  testIdPrefix="detail-loader"
                />
              </div>
            );
          },
          { name: "detail" },
        ),

        // Parallel segment: own loader + inherited MwChainLoader from layout.
        // Also reads handler-first vars to confirm parallels see them.
        parallel(
          {
            "@panel": (ctx) => {
              const layoutData = ctx.get(LayoutData);
              const handlerData = ctx.get(HandlerData);
              return (
                <div data-testid="mw-chain-parallel">
                  <span data-testid="parallel-layout-data">
                    {layoutData ?? "none"}
                  </span>
                  <span data-testid="parallel-handler-data">
                    {handlerData ?? "none"}
                  </span>
                  <MwChainClientDisplay
                    loader={MwChainLoader}
                    testIdPrefix="parallel-inherited"
                  />
                  <MwChainParallelClientDisplay
                    loader={MwChainParallelLoader}
                  />
                </div>
              );
            },
          },
          () => [loader(MwChainParallelLoader)],
        ),

        // Intercept: captures detail navigation via soft nav, renders as modal
        intercept(
          "@modal",
          ".detail",
          async (ctx) => {
            const globalVar = ctx.get("chainGlobal") as string | undefined;
            const routeVar = ctx.get(ChainRoute);
            const interceptVar = ctx.get("chainIntercept") as
              | string
              | undefined;

            return (
              <div data-testid="mw-chain-modal">
                <span data-testid="intercept-global-var">
                  {globalVar ?? "none"}
                </span>
                <span data-testid="intercept-route-var">
                  {routeVar ?? "none"}
                </span>
                <span data-testid="intercept-mw-var">
                  {interceptVar ?? "none"}
                </span>
                <MwChainActionButton testId="modal-action-btn" />
                <form action={mwChainFormAction} data-testid="modal-pe-form">
                  <button type="submit" data-testid="modal-pe-submit">
                    PE Action
                  </button>
                </form>
                <MwChainInterceptClientDisplay
                  loader={MwChainInterceptLoader}
                />
              </div>
            );
          },
          () => [
            when(({ from }) => from.pathname.startsWith("/mw-chain")),
            loader(MwChainInterceptLoader),
            middleware(async (ctx, next) => {
              ctx.set("chainIntercept", "from-intercept-mw");
              ctx.header("X-Chain-Intercept", "applied");
              cookies().set("chain-intercept", "iv", {
                path: "/",
                maxAge: 86400,
              });
              await next();
            }),
          ],
        ),
      ],
    ),
  ],
);
