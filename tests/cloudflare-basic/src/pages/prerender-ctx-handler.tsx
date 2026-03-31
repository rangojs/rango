import { Prerender, Passthrough, createVar } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

const SharedFromGetParams = createVar<string>();
const HandlerData = createVar<string>();

// Prerender handler with getParams context and handler-first data flow.
// "gamma" uses ctx.passthrough() to skip the build-time artifact and
// defer to the Passthrough live handler at runtime.
export const PrerenderCtxDef = Prerender<{ slug: string }>(
  async (ctx) => {
    ctx.set(SharedFromGetParams, "fetched-at-build");
    return [{ slug: "alpha" }, { slug: "beta" }, { slug: "gamma" }];
  },
  async (ctx) => {
    // gamma: skip prerender artifact, defer to live handler
    if (ctx.params.slug === "gamma") return ctx.passthrough();
    ctx.set(HandlerData, `data-for-${ctx.params.slug}`);
    return (
      <div data-testid="prerender-ctx-page">
        <h1 data-testid="prerender-ctx-title">{ctx.params.slug}</h1>
        <p data-testid="prerender-ctx-build">{String(ctx.build)}</p>
        <p data-testid="prerender-ctx-shared">
          {ctx.get(SharedFromGetParams) ?? "undefined"}
        </p>
        <p data-testid="prerender-ctx-timestamp">{Date.now()}</p>
      </div>
    );
  },
  { concurrency: 2 },
);

export const PrerenderCtxTest = Passthrough(PrerenderCtxDef, async (ctx) => {
  ctx.set(HandlerData, `data-for-${ctx.params.slug}`);
  return (
    <div data-testid="prerender-ctx-page">
      <h1 data-testid="prerender-ctx-title">{ctx.params.slug}</h1>
      <p data-testid="prerender-ctx-build">{String(ctx.build)}</p>
      <p data-testid="prerender-ctx-shared">
        {ctx.get(SharedFromGetParams) ?? "undefined"}
      </p>
      <p data-testid="prerender-ctx-timestamp">{Date.now()}</p>
    </div>
  );
});

// Orphan layout reads handler-set data via ctx.get().
export function PrerenderCtxLayout(ctx: any) {
  const handlerData = ctx.get(HandlerData);
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
  const handlerData = ctx.get(HandlerData);
  return (
    <aside data-testid="prerender-ctx-sidebar">
      <p data-testid="prerender-ctx-sidebar-data">
        {handlerData ?? "undefined"}
      </p>
    </aside>
  );
}
