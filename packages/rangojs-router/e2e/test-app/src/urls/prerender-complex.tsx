import { urls, Prerender } from "@rangojs/router";
import { ParallelOutlet } from "@rangojs/router/client";
import { PrerenderComplexLayout, PrerenderInnerLayout } from "../components/layouts/index.js";
import { FreshTimestampLoader } from "../loaders.js";
import { FreshDataDisplay } from "../components/FreshDataDisplay.js";

// Static index page with a parallel sidebar slot and fresh loader data
export const PrerenderComplexIndex = Prerender(async () => {
  return (
    <div data-testid="prerender-complex-index">
      <h1 data-testid="prerender-complex-index-title">Complex Index</h1>
      <p data-testid="prerender-complex-index-content">
        Pre-rendered index with parallel sidebar and fresh loader.
      </p>
      <FreshDataDisplay loader={FreshTimestampLoader} />
      <aside data-testid="prerender-complex-sidebar-area">
        <ParallelOutlet name="@sidebar" />
      </aside>
    </div>
  );
});

// Dynamic detail page with inner layout and fresh loader data
export const PrerenderComplexDetail = Prerender(
  async () => [{ slug: "alpha" }, { slug: "beta" }],
  async (ctx) => {
    return (
      <div data-testid="prerender-complex-detail">
        <h1 data-testid="prerender-complex-detail-title">{ctx.params.slug}</h1>
        <p data-testid="prerender-complex-detail-content">
          Detail content for {ctx.params.slug}
        </p>
        <FreshDataDisplay loader={FreshTimestampLoader} />
      </div>
    );
  }
);

// Parallel sidebar handler - pre-rendered as part of the B segment
function PrerenderSidebarHandler() {
  return (
    <div data-testid="prerender-sidebar">
      <h2 data-testid="prerender-sidebar-title">Sidebar</h2>
      <p data-testid="prerender-sidebar-content">Pre-rendered sidebar content.</p>
    </div>
  );
}

export const prerenderComplexPatterns = urls(
  ({ path, layout, parallel, loader }) => [
    layout(PrerenderComplexLayout, () => [
      path("/", PrerenderComplexIndex, { name: "index" }, () => [
        loader(FreshTimestampLoader),
        parallel({ "@sidebar": PrerenderSidebarHandler }),
      ]),
      layout(PrerenderInnerLayout, () => [
        path("/:slug", PrerenderComplexDetail, { name: "detail" }, () => [
          loader(FreshTimestampLoader),
        ]),
      ]),
    ]),
  ]
);
