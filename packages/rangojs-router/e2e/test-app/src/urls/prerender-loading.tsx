import { urls, Prerender, Passthrough } from "@rangojs/router";

// Prerender + loading() + ctx.passthrough() (M16 regression guard).
//
// The loading() boundary on the route defers the build handler, so its return
// value (including the ctx.passthrough() sentinel) arrives Promise-wrapped.
// detectPrerenderPassthrough must await that thenable before the synchronous
// sentinel check; otherwise the "skip" param bakes a corrupt artifact at build
// time instead of deferring to the live Passthrough handler.
export const PrerenderLoadingDef = Prerender<{ slug: string }>(
  async () => [{ slug: "baked" }, { slug: "skip" }],
  async (ctx) => {
    // skip: defer to the live Passthrough handler, do not bake an artifact.
    if (ctx.params.slug === "skip") return ctx.passthrough();
    return (
      <div data-testid="prerender-loading-page">
        <h1 data-testid="prerender-loading-title">{ctx.params.slug}</h1>
        <p data-testid="prerender-loading-build">{String(ctx.build)}</p>
        <p data-testid="prerender-loading-dev">{String(ctx.dev)}</p>
        <p data-testid="prerender-loading-source">baked</p>
        <p data-testid="prerender-loading-ts">{Date.now()}</p>
      </div>
    );
  },
  { concurrency: 2 },
);

// Live handler renders skipped/unknown params at runtime (ctx.build === false).
export const PrerenderLoadingTest = Passthrough(
  PrerenderLoadingDef,
  async (ctx) => (
    <div data-testid="prerender-loading-page">
      <h1 data-testid="prerender-loading-title">{ctx.params.slug}</h1>
      <p data-testid="prerender-loading-build">{String(ctx.build)}</p>
      <p data-testid="prerender-loading-dev">{String(ctx.dev)}</p>
      <p data-testid="prerender-loading-source">live</p>
      <p data-testid="prerender-loading-ts">{Date.now()}</p>
    </div>
  ),
);

export const prerenderLoadingPatterns = urls(({ path, loading }) => [
  path("/:slug", PrerenderLoadingTest, { name: "detail" }, () => [
    loading(<div data-testid="prerender-loading-skeleton">Loading...</div>),
  ]),
]);
