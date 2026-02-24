import { Prerender } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

// Prerender handler with getParams context and handler-first data flow.
export const PrerenderCtxTest = Prerender<{ slug: string }>(
  async (ctx) => {
    ctx.set("sharedFromGetParams", "fetched-at-build");
    return [{ slug: "alpha" }, { slug: "beta" }];
  },
  async (ctx) => {
    ctx.set("handlerData", `data-for-${ctx.params.slug}`);
    return (
      <div data-testid="prerender-ctx-page">
        <h1 data-testid="prerender-ctx-title">{ctx.params.slug}</h1>
        <p data-testid="prerender-ctx-build">{String(ctx.build)}</p>
        <p data-testid="prerender-ctx-shared">
          {ctx.get("sharedFromGetParams") ?? "undefined"}
        </p>
        <p data-testid="prerender-ctx-timestamp">{Date.now()}</p>
      </div>
    );
  },
  { passthrough: true, concurrency: 2 },
);

// Orphan layout reads handler-set data via ctx.get().
export function PrerenderCtxLayout(ctx: any) {
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
export function PrerenderCtxSidebar(ctx: any) {
  const handlerData = ctx.get("handlerData");
  return (
    <aside data-testid="prerender-ctx-sidebar">
      <p data-testid="prerender-ctx-sidebar-data">
        {handlerData ?? "undefined"}
      </p>
    </aside>
  );
}
