import { urls, Prerender } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { PrerenderInterceptLayout } from "../components/layouts/index.js";
import { FreshTimestampLoader } from "../loaders.js";
import { FreshDataDisplay } from "../components/FreshDataDisplay.js";
import { Modal } from "../components/Modal.js";
import type { Handler } from "@rangojs/router";

// Index page with links to pre-rendered items
const PrerenderInterceptIndex: Handler<"prerenderIntercept.index"> = () => (
  <div data-testid="pri-index">
    <h1 data-testid="pri-index-title">Pre-render Intercept Test</h1>
    <ul>
      <li>
        <Link to="/prerender-intercept/alpha" data-testid="pri-link-alpha">
          Alpha
        </Link>
      </li>
      <li>
        <Link to="/prerender-intercept/beta" data-testid="pri-link-beta">
          Beta
        </Link>
      </li>
    </ul>
  </div>
);

// Pre-rendered detail page (target of intercept)
export const PrerenderInterceptDetail = Prerender(
  async () => [{ slug: "alpha" }, { slug: "beta" }],
  async (ctx) => (
    <div data-testid="pri-detail">
      <h1 data-testid="pri-detail-title">{ctx.params.slug}</h1>
      <p data-testid="pri-detail-content">
        Full detail page for {ctx.params.slug}
      </p>
      <FreshDataDisplay loader={FreshTimestampLoader} />
      <Link to="/prerender-intercept" data-testid="pri-back-link">
        Back to list
      </Link>
    </div>
  ),
);

// Intercept handler: renders in @modal slot during client navigation
function PrerenderInterceptModalHandler(ctx: { params: { slug: string }; pathname: string }) {
  return (
    <Modal testId="pri-modal">
      <h2 data-testid="pri-modal-title">{ctx.params.slug}</h2>
      <p data-testid="pri-modal-indicator">Intercepted</p>
      <Link
        to={`/prerender-intercept/${ctx.params.slug}`}
        data-testid="pri-view-full"
      >
        View Full Page
      </Link>
    </Modal>
  );
}

export const prerenderInterceptPatterns = urls(
  ({ path, layout, intercept, loader, when }) => [
    layout(PrerenderInterceptLayout, () => [
      path("/", PrerenderInterceptIndex, { name: "index" }),

      path("/:slug", PrerenderInterceptDetail, { name: "detail" }, () => [
        loader(FreshTimestampLoader),
      ]),

      intercept(
        "@modal",
        ".detail",
        async (ctx) => <PrerenderInterceptModalHandler params={ctx.params} pathname={ctx.pathname} />,
        () => [
          when(({ from }) => from.pathname.startsWith("/prerender-intercept")),
        ],
      ),
    ]),
  ],
);
