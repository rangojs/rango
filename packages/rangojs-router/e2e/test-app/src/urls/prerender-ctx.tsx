import { urls, Prerender, Passthrough } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

// Prerender handler with getParams context and handler-first data flow.
// getParams sets shared data via ctx.set(), handler sets per-slug data,
// child layout and parallel read via ctx.get().
// "gamma" uses ctx.passthrough() to skip the build-time artifact and
// defer to live rendering at runtime via the Passthrough live handler.
export const PrerenderCtxDef = Prerender<{ slug: string }>(
  async (ctx) => {
    ctx.set("sharedFromGetParams", "fetched-at-build");
    return [{ slug: "alpha" }, { slug: "beta" }, { slug: "gamma" }];
  },
  async (ctx) => {
    // gamma: skip prerender artifact, defer to live handler
    if (ctx.params.slug === "gamma") return ctx.passthrough();
    ctx.set("handlerData", `data-for-${ctx.params.slug}`);
    return (
      <div data-testid="prerender-ctx-page">
        <h1 data-testid="prerender-ctx-title">{ctx.params.slug}</h1>
        <p data-testid="prerender-ctx-build">{String(ctx.build)}</p>
        <p data-testid="prerender-ctx-dev">{String(ctx.dev)}</p>
        <p data-testid="prerender-ctx-shared">
          {ctx.get("sharedFromGetParams") ?? "undefined"}
        </p>
        <p data-testid="prerender-ctx-timestamp">{Date.now()}</p>
      </div>
    );
  },
  { concurrency: 2 },
);

// Passthrough wraps the build-time definition with a live handler for
// unknown params (and gamma, which calls ctx.passthrough() above).
export const PrerenderCtxTest = Passthrough(PrerenderCtxDef, async (ctx) => {
  ctx.set("handlerData", `data-for-${ctx.params.slug}`);
  return (
    <div data-testid="prerender-ctx-page">
      <h1 data-testid="prerender-ctx-title">{ctx.params.slug}</h1>
      <p data-testid="prerender-ctx-build">{String(ctx.build)}</p>
      <p data-testid="prerender-ctx-dev">{String(ctx.dev)}</p>
      <p data-testid="prerender-ctx-shared">
        {ctx.get("sharedFromGetParams") ?? "undefined"}
      </p>
      <p data-testid="prerender-ctx-timestamp">{Date.now()}</p>
    </div>
  );
});

// Orphan layout reads handler-set data via ctx.get().
function PrerenderCtxLayout(ctx: any) {
  const handlerData = ctx.get("handlerData");
  return (
    <div data-testid="prerender-ctx-layout">
      <p data-testid="prerender-ctx-layout-data">
        {handlerData ?? "undefined"}
      </p>
      <Outlet />
      <ParallelOutlet name="@ctx-sidebar" />
    </div>
  );
}

// Parallel reads handler-set data via ctx.get().
function PrerenderCtxSidebar(ctx: any) {
  const handlerData = ctx.get("handlerData");
  return (
    <aside data-testid="prerender-ctx-sidebar">
      <p data-testid="prerender-ctx-sidebar-data">
        {handlerData ?? "undefined"}
      </p>
    </aside>
  );
}

export const prerenderCtxPatterns = urls(({ path, layout, parallel }) => [
  path("/:slug", PrerenderCtxTest, { name: "detail" }, () => [
    layout(PrerenderCtxLayout, () => [
      parallel({ "@ctx-sidebar": PrerenderCtxSidebar }),
    ]),
  ]),
]);
