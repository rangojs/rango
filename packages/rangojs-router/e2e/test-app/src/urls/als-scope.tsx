import { AsyncLocalStorage } from "node:async_hooks";
import { Suspense } from "react";
import { urls, createVar, getRequestContext } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import { AlsScopeLoader, type AlsScopeLoaderData } from "../loaders.js";
import { AlsScopeActionButton } from "../components/AlsScopeActionButton.js";
import { alsScopeAction } from "../actions.js";

// Typed context variables for each middleware scope.
// Global middleware sets AlsGlobalMark; route middleware sets AlsRouteMark;
// intercept middleware sets AlsInterceptMark.
// Each probe reads all three to show its scope visibility.
export const AlsGlobalMark = createVar<string>();
export const AlsRouteMark = createVar<string>();
export const AlsInterceptMark = createVar<string>();

// Custom AsyncLocalStorage instances owned by the application (not the framework).
// Top-level .use() middleware calls next() inside customGlobalAls.run().
// DSL middleware() calls next() inside customRouteAls.run().
// Probes read .getStore() directly to verify propagation through the
// framework's render pipeline, async boundaries, and streaming.
export const customGlobalAls = new AsyncLocalStorage<string>();
export const customRouteAls = new AsyncLocalStorage<string>();

/**
 * Async context (ALS) propagation test fixture.
 *
 * Validates three scope contracts:
 *
 * 1. Request scope (router.use) — AlsGlobalMark is visible everywhere:
 *    handlers, layouts, parallels, loaders, intercepts, async server
 *    components, streamed children, and server actions.
 *
 * 2. Render scope (route middleware) — AlsRouteMark is visible in the
 *    render tree but NOT inside the action itself.
 *
 * 3. Intercept scope (intercept middleware) — AlsInterceptMark is visible
 *    only in the intercept render path.
 *
 * Each probe outputs a "scope snapshot" string: the comma-joined list of
 * which markers are present (e.g. "global,route" or "global").
 */

function buildScopeSnapshot(ctx: { get: (v: any) => any }): string {
  const parts: string[] = [];
  if (ctx.get(AlsGlobalMark)) parts.push("global");
  if (ctx.get(AlsRouteMark)) parts.push("route");
  if (ctx.get(AlsInterceptMark)) parts.push("intercept");
  return parts.length > 0 ? parts.join(",") : "none";
}

// Reads the custom ALS instances directly (not via ctx.get) to prove
// user-owned AsyncLocalStorage survives through the framework pipeline.
function buildCustomAlsSnapshot(): string {
  const parts: string[] = [];
  if (customGlobalAls.getStore()) parts.push("top-mw");
  if (customRouteAls.getStore()) parts.push("dsl-mw");
  return parts.length > 0 ? parts.join(",") : "none";
}

// Async server component — reads ALS after an await to prove propagation
// through async boundaries. Uses read probes only, not handle/meta mutation
// (which have separate late-stream limits).
async function AsyncProbe() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const ctx = getRequestContext();
  const scope = buildScopeSnapshot(ctx);
  const customAls = buildCustomAlsSnapshot();
  const requestId = ctx.get("alsRequestId") as string | undefined;
  return (
    <div data-testid="als-async-probe">
      <span data-testid="als-async-scope">{scope}</span>
      <span data-testid="als-async-request-id">{requestId ?? "none"}</span>
      <span data-testid="als-async-custom">{customAls}</span>
    </div>
  );
}

// Streamed async component behind loading() — reads ALS after a longer
// delay to prove ALS survives through the streaming/Suspense boundary.
async function StreamedProbe() {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const ctx = getRequestContext();
  const scope = buildScopeSnapshot(ctx);
  const customAls = buildCustomAlsSnapshot();
  const requestId = ctx.get("alsRequestId") as string | undefined;
  return (
    <div data-testid="als-streamed-probe">
      <span data-testid="als-streamed-scope">{scope}</span>
      <span data-testid="als-streamed-request-id">{requestId ?? "none"}</span>
      <span data-testid="als-streamed-custom">{customAls}</span>
    </div>
  );
}

export const alsScopePatterns = urls(
  ({
    path,
    layout,
    middleware,
    loader,
    parallel,
    intercept,
    when,
    revalidate,
  }) => [
    // Route middleware: sets AlsRouteMark and runs next() inside customRouteAls.
    // Wraps renders and revalidation but NOT action execution.
    middleware(async (ctx, next) => {
      ctx.set(AlsRouteMark, "applied");
      return customRouteAls.run(`dsl-mw:${crypto.randomUUID()}`, () => next());
    }),

    layout(
      async (ctx) => {
        const scope = buildScopeSnapshot(ctx);
        const customAls = buildCustomAlsSnapshot();
        const requestId = ctx.get("alsRequestId") as string | undefined;
        const loaderData = (await ctx.use(
          AlsScopeLoader,
        )) as AlsScopeLoaderData;
        return (
          <div data-testid="als-layout">
            <span data-testid="als-layout-scope">{scope}</span>
            <span data-testid="als-layout-custom">{customAls}</span>
            <span data-testid="als-layout-request-id">
              {requestId ?? "none"}
            </span>
            <span data-testid="als-loader-scope">{loaderData.scope}</span>
            <span data-testid="als-loader-custom">{loaderData.customAls}</span>
            <span data-testid="als-loader-request-id">
              {loaderData.requestId}
            </span>
            <Outlet />
            <ParallelOutlet name="@panel" />
            <ParallelOutlet name="@modal" />
          </div>
        );
      },
      () => [
        revalidate(() => true),
        loader(AlsScopeLoader),

        // Orphan layout inside the main layout — wraps the index path.
        // Handler-first: this layout executes after the path handler,
        // so it sees handler-set data AND ALS context.
        layout(
          (ctx) => {
            const scope = buildScopeSnapshot(ctx);
            const requestId = ctx.get("alsRequestId") as string | undefined;
            return (
              <div data-testid="als-orphan-layout">
                <span data-testid="als-orphan-scope">{scope}</span>
                <span data-testid="als-orphan-request-id">
                  {requestId ?? "none"}
                </span>
                <Outlet />
              </div>
            );
          },
          () => [
            // Index handler
            path(
              "/",
              async (ctx) => {
                const scope = buildScopeSnapshot(ctx);
                const customAls = buildCustomAlsSnapshot();
                const requestId = ctx.get("alsRequestId") as string | undefined;
                const actionProbe = ctx.get("alsActionProbe") as
                  | string
                  | undefined;
                const actionCustomProbe = ctx.get("alsActionCustomProbe") as
                  | string
                  | undefined;

                return (
                  <div data-testid="als-page">
                    <span data-testid="als-handler-scope">{scope}</span>
                    <span data-testid="als-handler-custom">{customAls}</span>
                    <span data-testid="als-handler-request-id">
                      {requestId ?? "none"}
                    </span>
                    <span data-testid="als-handler-custom-global-raw">
                      {customGlobalAls.getStore() ?? "none"}
                    </span>
                    <span data-testid="als-handler-custom-route-raw">
                      {customRouteAls.getStore() ?? "none"}
                    </span>
                    <span data-testid="als-action-probe">
                      {actionProbe ?? "none"}
                    </span>
                    <span data-testid="als-action-custom-probe">
                      {actionCustomProbe ?? "none"}
                    </span>

                    <AsyncProbe />

                    <Suspense
                      fallback={
                        <div data-testid="als-loading">
                          Loading streamed content...
                        </div>
                      }
                    >
                      <StreamedProbe />
                    </Suspense>

                    <AlsScopeActionButton />
                    <form action={alsScopeAction} data-testid="als-pe-form">
                      <button type="submit" data-testid="als-pe-submit">
                        PE Action
                      </button>
                    </form>

                    <Link
                      to="/als-scope/detail/test-slug"
                      data-testid="als-detail-link"
                    >
                      Detail
                    </Link>
                  </div>
                );
              },
              { name: "index" },
            ),
          ],
        ),

        // Detail handler — target for intercept
        path(
          "/detail/:slug",
          (ctx) => {
            const scope = buildScopeSnapshot(ctx);
            const requestId = ctx.get("alsRequestId") as string | undefined;
            return (
              <div data-testid="als-detail-page">
                <span data-testid="als-detail-scope">{scope}</span>
                <span data-testid="als-detail-request-id">
                  {requestId ?? "none"}
                </span>
                <span data-testid="als-detail-slug">{ctx.params.slug}</span>
              </div>
            );
          },
          { name: "detail" },
        ),

        // Parallel — reads ALS to confirm propagation to parallel slots
        parallel({
          "@panel": (ctx) => {
            const scope = buildScopeSnapshot(ctx);
            const customAls = buildCustomAlsSnapshot();
            const requestId = ctx.get("alsRequestId") as string | undefined;
            return (
              <div data-testid="als-parallel">
                <span data-testid="als-parallel-scope">{scope}</span>
                <span data-testid="als-parallel-custom">{customAls}</span>
                <span data-testid="als-parallel-request-id">
                  {requestId ?? "none"}
                </span>
              </div>
            );
          },
        }),

        // Intercept: captures detail navigation, renders as modal
        intercept(
          "@modal",
          ".detail",
          (ctx) => {
            const scope = buildScopeSnapshot(ctx);
            const customAls = buildCustomAlsSnapshot();
            const requestId = ctx.get("alsRequestId") as string | undefined;
            return (
              <div data-testid="als-modal">
                <span data-testid="als-intercept-scope">{scope}</span>
                <span data-testid="als-intercept-custom">{customAls}</span>
                <span data-testid="als-intercept-request-id">
                  {requestId ?? "none"}
                </span>
              </div>
            );
          },
          () => [
            when(({ from }) => from.pathname.startsWith("/als-scope")),
            middleware(async (ctx, next) => {
              ctx.set(AlsInterceptMark, "applied");
              await next();
            }),
          ],
        ),
      ],
    ),
  ],
);
