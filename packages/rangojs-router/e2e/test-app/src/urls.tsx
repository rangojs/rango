import { urls, cookies, Meta, Breadcrumbs, notFound } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { RootLayout } from "./components/layouts/index.js";
import { blogPatterns } from "./urls/blog.js";
import { createFactoryHmrPatterns } from "./urls/factory-hmr.js";
import { slowPatternsWithoutDetail } from "./urls/slow.js";
import { errorsPatterns } from "./urls/errors.js";
import {
  metaTemplatePatterns,
  metaUnsetPatterns,
  metaMergePatterns,
  handlePatterns,
  hydrationPatterns,
  trailingSlashPatterns,
} from "./urls/meta.js";
import { hooksPatterns } from "./urls/hooks.js";
import { sharedRefetchPatterns } from "./urls/shared-refetch.js";
import { keyRefreshPatterns } from "./urls/key-refresh.js";
import { middlewarePatterns } from "./urls/middleware.js";
import { cachePatterns } from "./urls/cache.js";
import { themePatterns } from "./urls/theme.js";
import { hrefPatterns } from "./urls/href.js";
import { unnamedIncludeReversePatterns } from "./urls/unnamed-include-reverse.js";
import {
  flattenedIncludePatterns,
  namedIncludePatterns,
} from "./urls/include-scoping-reverse.js";
import { searchPatterns } from "./urls/search.js";
import { refTestPatterns } from "./urls/ref-test.js";
import { prerenderPatterns } from "./urls/prerender.js";
import { prerenderComplexPatterns } from "./urls/prerender-complex.js";
import { prerenderInterceptPatterns } from "./urls/prerender-intercept.js";
import { transformCasesPatterns } from "./urls/transform-cases.js";
import { apiShopPatterns } from "./urls/api-shop.js";
import { locationStatePatterns } from "./urls/location-state.js";
import { responseCachePatterns } from "./urls/response-cache.js";
import { includeMiddlewarePatterns } from "./urls/include-middleware.js";
import {
  optionalIncludePatterns,
  constrainedOptionalIncludePatterns,
} from "./urls/optional-include.js";
import { handlerFirstPatterns } from "./urls/handler-first.js";
import { handlerUsePatterns } from "./urls/handler-use.js";
import { parallelLoaderInheritPatterns } from "./urls/parallel-loader-inherit.js";
import { buildSkipPatterns } from "./urls/prerender-build-skip.js";
import { prerenderCtxPatterns } from "./urls/prerender-ctx.js";
import { reverseAutofillPatterns } from "./urls/reverse-autofill.js";
import { clientReversePatterns } from "./urls/client-reverse.js";
import { useCachePatterns } from "./urls/use-cache.js";
import { prerenderLocalePatterns } from "./urls/prerender-locale.js";
import { loaderReversePatterns } from "./urls/loader-reverse.js";
import { loaderCookiePatterns } from "./urls/loader-cookie.js";
import { mwChainPatterns } from "./urls/mw-chain.js";
import { revalidationContractPatterns } from "./urls/revalidation-contract.js";
import { ctxCleanPatterns } from "./urls/ctx-clean.js";
import { actionRedirectRevalidationPatterns } from "./urls/action-redirect-revalidation.js";
import { hashNavigationPatterns } from "./urls/hash-navigation.js";
import { linkBehaviorPatterns } from "./urls/link-behavior.js";
import { delayedBreadcrumbPatterns } from "./urls/delayed-breadcrumbs.js";
import { breadcrumbTrailPatterns } from "./urls/breadcrumb-trail.js";
import { manifestCacheTestPatterns } from "./urls/manifest-cache-test.js";
import { authBoundaryPatterns } from "./urls/auth-boundary.js";
import { contentOwnershipPatterns } from "./urls/content-ownership.js";
import { cacheIsolationPatterns } from "./urls/cache-isolation.js";
import { cacheTagPatterns } from "./urls/cache-tag.js";
import { actionCtxSetPatterns } from "./urls/action-ctx-set.js";
import { isActionPatterns } from "./urls/is-action.js";
import { paramsAfterActionPatterns } from "./urls/params-after-action.js";
import { middlewareWrappingPatterns } from "./urls/middleware-wrapping.js";
import { alsScopePatterns } from "./urls/als-scope.js";
import { streamModePatterns } from "./urls/stream-mode.js";
import { devDebugPatterns, devInfoHandler } from "./urls/dev-routes.js";
import { contextDedupPatterns } from "./urls/context-dedup.js";
import { parallelMetaPatterns } from "./urls/parallel-meta.js";
import { parallelMetaStalePatterns } from "./urls/parallel-meta-stale.js";
import { renderedBarrierPatterns } from "./urls/rendered-barrier.js";
import { cacheScopeGuardPatterns } from "./urls/cache-scope-guard.js";
import { colocatedLoaderPrerenderPatterns } from "./urls/colocated-loader-prerender.js";
import { parallelLoaderRevalPatterns } from "./urls/parallel-loader-reval.js";
import { parallelRevalAfterActionPatterns } from "./urls/parallel-reval-after-action.js";
import { IncludeMwLayout } from "./components/layouts/IncludeMwLayout.js";
import { ShopPlayground } from "./components/ShopPlayground.js";
import {
  ProductsLoader,
  ProductDetailLoader,
  CartQuantityLoader,
  SlowProductDetailLoader,
  SwrProductLoader,
} from "./loaders.js";
import { SwrProductCounter } from "./components/SwrProductCounter.js";
import { SlowProductLocationState } from "./location-states.js";
import { onErrorLog, clearOnErrorLog } from "./error-log.js";
import { Modal } from "./components/Modal.js";
import { QuantityControl } from "./components/QuantityControl.js";
import { SlowModalSkeleton } from "./components/SlowModalSkeleton.js";
import { LoadingFnSkeleton } from "./components/LoadingFnSkeleton.js";
import {
  StreamingActionButton,
  StreamingActionStatus,
} from "./components/StreamingActionButton.js";
import { AddToCartButton } from "./components/AddToCartButton.js";
import { LinkPendingBadge } from "./components/LinkStatusDisplay.js";
import { RevalidateButton } from "./components/RevalidateButton.js";
import {
  interceptIndicatorText,
  shouldInterceptProduct,
} from "./intercept-hmr-config.js";

/**
 * Shell layout for the block-form transition group. The transition() block
 * wrapper layout is transparent (no testid), so this explicit shell gives the
 * same-route-nav test a DOM node to assert the shared wrapper chain persists
 * (is not remounted) across a cross-route navigation inside the block.
 */
function TxBlockShell(): React.ReactNode {
  return (
    <div data-testid="tx-block-shell">
      <Outlet />
    </div>
  );
}

/**
 * Main URL patterns - Django-style routing API
 *
 * Core routes (index, product) and slow-product route are defined inline
 * because they have intercepts that need to share the same parent context.
 * Other routes are included from separate modules.
 */
export const urlpatterns = urls(
  ({
    layout,
    path,
    include,
    intercept,
    loader,
    loading,
    transition,
    when,
    middleware,
    parallel,
  }) => [
    layout(RootLayout, () => [
      // === CORE ROUTES (inline for intercept support) ===

      // Index route - product list
      path(
        "/",
        async (ctx) => {
          const { products, loadedAt } = await ctx.use(ProductsLoader);
          return (
            <div data-testid="index-page">
              <h1 data-testid="page-title">Products</h1>
              <p data-testid="loaded-at">Loaded: {loadedAt}</p>
              <div data-testid="product-list">
                {products.map((product) => (
                  <div
                    key={product.id}
                    data-testid={`product-card-${product.id}`}
                  >
                    <Link
                      to={`/product/${product.id}`}
                      data-testid={`product-link-${product.id}`}
                    >
                      <h3>{product.name}</h3>
                      <p>${product.price}</p>
                      <LinkPendingBadge />
                    </Link>
                  </div>
                ))}
              </div>
              <div data-testid="link-status-test" style={{ marginTop: "2rem" }}>
                <h2>Link Status Tests (useLinkStatus)</h2>
                <p style={{ fontSize: "12px", color: "#666" }}>
                  Click a link to see its pending badge change. Only the clicked
                  link shows pending.
                </p>
                <ul>
                  <li>
                    <Link to="/slow" data-testid="link-status-slow">
                      Slow Route <LinkPendingBadge />
                    </Link>
                  </li>
                  <li>
                    <Link
                      to="/slow-streaming"
                      data-testid="link-status-slow-streaming"
                    >
                      Slow Streaming <LinkPendingBadge />
                    </Link>
                  </li>
                  <li>
                    <Link to="/blog" data-testid="link-status-blog">
                      Blog <LinkPendingBadge />
                    </Link>
                  </li>
                </ul>
              </div>
              <div
                data-testid="loader-test-links"
                style={{ marginTop: "2rem" }}
              >
                <h2>Loader Behavior Tests</h2>
                <ul>
                  <li>
                    <Link to="/slow" data-testid="slow-link">
                      /slow - No loading (awaited)
                    </Link>
                  </li>
                  <li>
                    <Link
                      to="/slow-streaming"
                      data-testid="slow-streaming-link"
                    >
                      /slow-streaming - With loading (streaming)
                    </Link>
                  </li>
                  <li>
                    <Link
                      to="/slow-streaming-skip-ssr"
                      data-testid="slow-skip-ssr-link"
                    >
                      /slow-streaming-skip-ssr - Skip SSR loading
                    </Link>
                  </li>
                  <li>
                    <Link
                      to="/slow-product/slow-product-a"
                      state={[
                        SlowProductLocationState({
                          productName: "Slow Product A",
                          productPrice: 99,
                        }),
                      ]}
                      data-testid="slow-product-link"
                    >
                      /slow-product - Intercept with streaming loader (with
                      state)
                    </Link>
                  </li>
                  <li>
                    <Link
                      to="/slow-product/slow-product-b"
                      data-testid="slow-product-link-no-state"
                    >
                      /slow-product - Intercept without state
                    </Link>
                  </li>
                </ul>
              </div>
            </div>
          );
        },
        { name: "index" },
        () => [loader(ProductsLoader)],
      ),

      // Product detail route (direct navigation)
      path(
        "/product/:productId",
        async (ctx) => {
          // Push product breadcrumb with async content
          const pushBreadcrumb = ctx.use(Breadcrumbs);
          const meta = ctx.use(Meta);
          const { product, loadedAt } = await ctx.use(ProductDetailLoader);
          const { quantity } = await ctx.use(CartQuantityLoader);

          // Set page-specific meta after awaiting product data (streaming metadata test)
          meta({ title: `${product.name} - RSC Router Test App` });
          meta({ name: "description", content: product.description });
          meta({ property: "og:title", content: product.name });
          // JSON-LD structured data for product
          meta({
            "script:ld+json": {
              "@context": "https://schema.org",
              "@type": "Product",
              name: product.name,
              description: product.description,
              offers: {
                "@type": "Offer",
                price: product.price,
                priceCurrency: "USD",
              },
            },
          });

          pushBreadcrumb({
            label: product.name,
            href: `/product/${product.id}`,
            content: new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve(
                    <span data-testid="breadcrumb-async">
                      Loaded: {loadedAt}
                    </span>,
                  ),
                1000,
              ),
            ),
          });
          return (
            <div data-testid="product-detail-page">
              <Link to="/" data-testid="back-link">
                ← Back to Products
              </Link>
              <h1 data-testid="product-name">{product.name}</h1>
              <p data-testid="product-price">${product.price}</p>
              <p data-testid="product-description">{product.description}</p>
              <p data-testid="product-loaded-at">Loaded: {loadedAt}</p>
              <div data-testid="actions-section">
                <h2>Actions</h2>
                <div data-testid="add-to-cart-section">
                  <h3>1. Add to Cart (with result)</h3>
                  <AddToCartButton
                    productId={product.id}
                    testId="add-to-cart-btn"
                  />
                </div>
                <div data-testid="quantity-section">
                  <h3>2. Quantity Control (optimistic)</h3>
                  <QuantityControl
                    productId={product.id}
                    initialQuantity={quantity}
                    testId="quantity-control"
                  />
                </div>
                <div data-testid="streaming-section">
                  <h3>3. Streaming Action (3s delay)</h3>
                  <StreamingActionStatus />
                  <StreamingActionButton
                    productId={product.id}
                    testId="streaming-btn"
                  />
                </div>
              </div>
              <div data-testid="segment-metadata">
                <h3>Segment Metadata</h3>
                <ul>
                  <li>Product ID: {product.id}</li>
                  <li>Rendered: {new Date().toISOString()}</li>
                </ul>
              </div>
            </div>
          );
        },
        { name: "product.detail" },
        () => [loader(ProductDetailLoader), loader(CartQuantityLoader)],
      ),

      // Slow product detail route (direct navigation) - inline for intercept support
      path(
        "/slow-product/:productId",
        async (ctx) => {
          const { product, loadedAt } = await ctx.use(SlowProductDetailLoader);
          return (
            <div data-testid="slow-product-detail-page">
              <Link to="/" data-testid="back-link">
                ← Back to Products
              </Link>
              <h1 data-testid="slow-product-name">{product.name}</h1>
              <p data-testid="slow-product-price">${product.price}</p>
              <p data-testid="slow-product-description">
                {product.description}
              </p>
              <p data-testid="slow-product-loaded-at">Loaded: {loadedAt}</p>
              <div data-testid="slow-product-segment-metadata">
                <h3>Segment Metadata</h3>
                <ul>
                  <li>Product ID: {product.id}</li>
                  <li>Rendered: {new Date().toISOString()}</li>
                </ul>
              </div>
            </div>
          );
        },
        { name: "slowProduct.detail" },
        () => [loader(SlowProductDetailLoader)],
      ),

      // Same-route stale-while-revalidate test route. Has a :param, a
      // route-level loading() skeleton, AND opts in via transition(). So
      // navigating /swr-product/1 -> /swr-product/2 reconciles the route
      // subtree (param-agnostic key) and the existing transition startTransition
      // wrap keeps the previous content on screen until the new loader resolves
      // (no skeleton). Works on stable React (no ViewTransition needed).
      path(
        "/swr-product/:id",
        async (ctx) => {
          const { id, name, loadedAt } = await ctx.use(SwrProductLoader);
          return (
            <div data-testid="swr-product-page">
              <h1 data-testid="swr-product-name">{name}</h1>
              <p data-testid="swr-product-loaded-at">{loadedAt}</p>
              <SwrProductCounter />
              <nav>
                <Link to="/swr-product/1" data-testid="swr-product-link-1">
                  Product 1
                </Link>
                <Link to="/swr-product/2" data-testid="swr-product-link-2">
                  Product 2
                </Link>
                <Link to="/swr-product/3" data-testid="swr-product-link-3">
                  Product 3
                </Link>
                <Link
                  to="/slow-streaming"
                  data-testid="swr-product-cross-route-link"
                >
                  Cross-route (slow-streaming)
                </Link>
              </nav>
            </div>
          );
        },
        { name: "swrProduct.detail" },
        () => [
          loader(SwrProductLoader),
          loading(
            <div data-testid="swr-product-skeleton">Loading product…</div>,
          ),
          transition({}),
        ],
      ),

      // Boundary opt-out variant: identical to /swr-product but opts out of the
      // router's own <ViewTransition> via transition({ viewTransition: false }).
      // Pins that the flag keeps the startTransition driving and content-hold:
      // navigating /swr-product-vtoff/1 -> /2 must still reconcile and hold the
      // previous content (no skeleton flash) on stable React, exactly like
      // transition({}). The flag only suppresses the boundary (a no-op visually
      // on stable React, which has no ViewTransition), never the hold.
      path(
        "/swr-product-vtoff/:id",
        async (ctx) => {
          const { name, loadedAt } = await ctx.use(SwrProductLoader);
          return (
            <div data-testid="swr-product-vtoff-page">
              <h1 data-testid="swr-product-vtoff-name">{name}</h1>
              <p data-testid="swr-product-vtoff-loaded-at">{loadedAt}</p>
              <SwrProductCounter />
              <nav>
                <Link
                  to="/swr-product-vtoff/1"
                  data-testid="swr-product-vtoff-link-1"
                >
                  Product 1
                </Link>
                <Link
                  to="/swr-product-vtoff/2"
                  data-testid="swr-product-vtoff-link-2"
                >
                  Product 2
                </Link>
              </nav>
            </div>
          );
        },
        { name: "swrProductVtoff.detail" },
        () => [
          loader(SwrProductLoader),
          loading(
            <div data-testid="swr-product-vtoff-skeleton">
              Loading product…
            </div>,
          ),
          transition({ viewTransition: false }),
        ],
      ),

      // Contrast route: same :param + loading() skeleton, but WITHOUT
      // transition(). This is the default behavior — navigating between params
      // remounts the route and shows the skeleton. Pins that the opt-in is
      // required and the default is unchanged.
      path(
        "/plain-product/:id",
        async (ctx) => {
          const { id, name, loadedAt } = await ctx.use(SwrProductLoader);
          return (
            <div data-testid="plain-product-page">
              <h1 data-testid="plain-product-name">{name}</h1>
              <p data-testid="plain-product-loaded-at">{loadedAt}</p>
              <SwrProductCounter />
              <nav>
                <Link to="/plain-product/1" data-testid="plain-product-link-1">
                  Product 1
                </Link>
                <Link to="/plain-product/2" data-testid="plain-product-link-2">
                  Product 2
                </Link>
              </nav>
            </div>
          );
        },
        { name: "plainProduct.detail" },
        () => [
          loader(SwrProductLoader),
          loading(
            <div data-testid="plain-product-skeleton">Loading product…</div>,
          ),
        ],
      ),

      // Block-form transition scope: two distinct param routes share ONE
      // transition() wrapper. Same-route nav (/tx-group-a/1 -> /2) holds (the
      // wrapper puts the route in a transition scope -> param-agnostic key).
      // Cross-route nav (/tx-group-a -> /tx-group-b) remounts and shows the
      // destination skeleton; the shared TxBlockShell + wrapper persist. This
      // pins that transition GROUPING only affects animation, never hold/skeleton
      // across different routes.
      layout(TxBlockShell, () => [
        transition({}, () => [
          path(
            "/tx-group-a/:id",
            async (ctx) => {
              const { name, loadedAt } = await ctx.use(SwrProductLoader);
              return (
                <div data-testid="tx-group-a-page">
                  <h1 data-testid="tx-group-a-name">{name}</h1>
                  <p data-testid="tx-group-a-loaded-at">{loadedAt}</p>
                  <nav>
                    <Link to="/tx-group-a/1" data-testid="tx-a-link-1">
                      A1
                    </Link>
                    <Link to="/tx-group-a/2" data-testid="tx-a-link-2">
                      A2
                    </Link>
                    <Link to="/tx-group-b/1" data-testid="tx-cross-b-link">
                      to B
                    </Link>
                  </nav>
                </div>
              );
            },
            { name: "txGroup.a" },
            () => [
              loader(SwrProductLoader),
              loading(<div data-testid="tx-group-a-skeleton">Loading…</div>),
            ],
          ),
          path(
            "/tx-group-b/:id",
            async (ctx) => {
              const { name, loadedAt } = await ctx.use(SwrProductLoader);
              return (
                <div data-testid="tx-group-b-page">
                  <h1 data-testid="tx-group-b-name">{name}</h1>
                  <p data-testid="tx-group-b-loaded-at">{loadedAt}</p>
                </div>
              );
            },
            { name: "txGroup.b" },
            () => [
              loader(SwrProductLoader),
              loading(<div data-testid="tx-group-b-skeleton">Loading…</div>),
            ],
          ),
        ]),
      ]),

      // Own-transitions: two routes each wrapped in its OWN transition() block.
      // Navigating between them is cross-route -> remount -> destination skeleton
      // (being in a transition scope never suppresses a cross-route skeleton).
      transition({}, () => [
        path(
          "/own-tx-one/:id",
          async (ctx) => {
            const { name } = await ctx.use(SwrProductLoader);
            return (
              <div data-testid="own-tx-one-page">
                <h1 data-testid="own-tx-one-name">{name}</h1>
                <Link to="/own-tx-two/1" data-testid="own-tx-cross-link">
                  to two
                </Link>
              </div>
            );
          },
          { name: "ownTxOne" },
          () => [
            loader(SwrProductLoader),
            loading(<div data-testid="own-tx-one-skeleton">Loading…</div>),
          ],
        ),
      ]),
      transition({}, () => [
        path(
          "/own-tx-two/:id",
          async (ctx) => {
            const { name } = await ctx.use(SwrProductLoader);
            return (
              <div data-testid="own-tx-two-page">
                <h1 data-testid="own-tx-two-name">{name}</h1>
              </div>
            );
          },
          { name: "ownTxTwo" },
          () => [
            loader(SwrProductLoader),
            loading(<div data-testid="own-tx-two-skeleton">Loading…</div>),
          ],
        ),
      ]),

      // === PARALLEL SEGMENTS ===
      // Sidebar persists across all routes in this layout
      parallel({
        "@sidebar": () => (
          <aside data-testid="sidebar">
            <h3 data-testid="sidebar-title">Sidebar</h3>
            <p>Navigation links and filters</p>
          </aside>
        ),
      }),

      // === INTERCEPTS ===
      // Defined after routes but in same layout callback for shared parent context

      // Product detail intercept - only when navigating from index page
      intercept(
        "@modal",
        ".product.detail",
        async (ctx) => {
          const { product } = await ctx.use(ProductDetailLoader);
          const { quantity } = await ctx.use(CartQuantityLoader);
          return (
            <Modal testId="product-modal">
              <div data-testid="modal-header">
                <span data-testid="intercept-indicator">
                  {interceptIndicatorText}
                </span>
                <h2 data-testid="modal-product-name">{product.name}</h2>
              </div>
              <p data-testid="modal-product-price">${product.price}</p>
              <p data-testid="modal-product-description">
                {product.description}
              </p>
              <div data-testid="modal-quantity">
                <QuantityControl
                  productId={product.id}
                  initialQuantity={quantity}
                  testId="modal-quantity-control"
                />
              </div>
              <Link
                to={`/product/${product.id}`}
                data-testid="view-full-details"
                style={{
                  display: "inline-block",
                  marginTop: "16px",
                  padding: "8px 16px",
                  background: "#2196F3",
                  color: "white",
                  textDecoration: "none",
                  borderRadius: "4px",
                }}
              >
                View Full Details
              </Link>
            </Modal>
          );
        },
        () => [
          when(({ from }) => shouldInterceptProduct(from.pathname)),
          loader(ProductDetailLoader),
          loader(CartQuantityLoader),
        ],
      ),

      // Slow product intercept - with loading state
      intercept(
        "@modal",
        ".slowProduct.detail",
        async (ctx) => {
          const { product } = await ctx.use(SlowProductDetailLoader);
          return (
            <Modal testId="slow-product-modal">
              <div data-testid="slow-modal-header">
                <span data-testid="slow-intercept-indicator">Intercepted</span>
                <h2 data-testid="slow-modal-product-name">{product.name}</h2>
              </div>
              <p data-testid="slow-modal-product-price">${product.price}</p>
              <p data-testid="slow-modal-product-description">
                {product.description}
              </p>
              <div data-testid="slow-modal-streaming-section">
                <h3>Streaming Action (3s delay)</h3>
                <StreamingActionStatus />
                <StreamingActionButton
                  productId={product.id!}
                  testId="slow-modal-streaming-btn"
                />
              </div>
              <Link
                to={`/slow-product/${product.id}`}
                data-testid="slow-view-full-details"
                style={{
                  display: "inline-block",
                  marginTop: "16px",
                  padding: "8px 16px",
                  background: "#2196F3",
                  color: "white",
                  textDecoration: "none",
                  borderRadius: "4px",
                }}
              >
                View Full Details
              </Link>
            </Modal>
          );
        },
        () => [
          loader(SlowProductDetailLoader),
          loading(<SlowModalSkeleton />),
          middleware(async (ctx, next) => {
            await next();
            ctx.header("X-Intercept-Middleware", "applied");
            cookies().set("intercept-visited", "true", { path: "/" });
          }),
        ],
      ),

      // === INCLUDED PATTERNS (no intercepts needed) ===

      // Blog patterns
      include("/blog", blogPatterns, { name: "blog" }),

      // Factory-generated patterns (static parser can't resolve the function call)
      include("/factory-hmr", createFactoryHmrPatterns(), {
        name: "factoryHmr",
      }),

      // Slow/streaming patterns (without slowProduct.detail which is inline above)
      include("/", slowPatternsWithoutDetail, { name: "" }),

      // Error patterns - already has /errors prefix in paths
      include("/", errorsPatterns, { name: "" }),

      // Meta patterns - already have their prefixes in paths
      include("/meta-template", metaTemplatePatterns, { name: "metaTemplate" }),
      include("/meta-unset", metaUnsetPatterns, { name: "metaUnset" }),
      include("/meta-merge", metaMergePatterns, { name: "metaMerge" }),

      // Handle passthrough and hydration patterns
      include("/", handlePatterns, { name: "" }),
      include("/", hydrationPatterns, { name: "" }),
      include("/", delayedBreadcrumbPatterns, { name: "" }),
      include("/", breadcrumbTrailPatterns, { name: "" }),

      // Trailing slash patterns
      include("/", trailingSlashPatterns, { name: "" }),

      // Hook test patterns - already have their prefixes in paths
      include("/", hooksPatterns, { name: "" }),

      // Shared-refetch regression scenario
      include("/", sharedRefetchPatterns, { name: "" }),

      // Client refresh key (useLoader/useFetchLoader { key }) scenarios
      include("/", keyRefreshPatterns, { name: "" }),

      // Middleware test patterns
      include("/middleware-test", middlewarePatterns, {
        name: "middlewareTest",
      }),

      // Cache test patterns (includes intercepts with layouts)
      include("/", cachePatterns, { name: "" }),

      // Theme patterns
      include("/theme", themePatterns, { name: "theme" }),

      // Href test patterns
      include("/href", hrefPatterns, { name: "href" }),

      // Include scoping reverse behavior probes
      include("/unnamed-reverse", unnamedIncludeReversePatterns),
      include("/flat-reverse", flattenedIncludePatterns, { name: "" }),
      include("/ns-reverse", namedIncludePatterns, { name: "ns" }),

      // Same patterns mounted twice under different prefixes — the
      // useReverse(routes) e2e spec exercises the hook from these.
      include("/cr/a/:tenantId", clientReversePatterns, { name: "crA" }),
      include("/cr/b/:tenantId", clientReversePatterns, { name: "crB" }),

      // Search params test patterns
      include("/search", searchPatterns, { name: "search" }),

      // Ref serialization test patterns
      include("/ref-test", refTestPatterns, { name: "refTest" }),

      // Pre-render handler test patterns
      include("/", prerenderPatterns, { name: "" }),

      // Pre-render complex test patterns (layout + parallel + fresh loader)
      include("/prerender-complex", prerenderComplexPatterns, {
        name: "prerenderComplex",
      }),

      // Pre-render + intercept test patterns
      include("/prerender-intercept", prerenderInterceptPatterns, {
        name: "prerenderIntercept",
      }),

      // Transform coverage patterns (alias imports + export specifiers)
      include("/transform-cases", transformCasesPatterns, {
        name: "transformCases",
      }),

      // Shop API patterns (JSON response routes)
      include("/api/shop", apiShopPatterns, { name: "apiShop" }),

      // Location state test patterns (redirect with state, flash messages)
      include("/location-state", locationStatePatterns, {
        name: "locationState",
      }),

      // Response route caching test patterns (cache() with various MIME types)
      include("/response-cache", responseCachePatterns, {
        name: "responseCache",
      }),

      // Handler-first execution order + cache scope tests
      include("/handler-first", handlerFirstPatterns, { name: "handlerFirst" }),

      // handler.use composable defaults test patterns
      include("/handler-use", handlerUsePatterns, { name: "handlerUse" }),

      // loading() function form tests
      path(
        "/loading-fn-test",
        async () => {
          await new Promise((r) => setTimeout(r, 200));
          return <div data-testid="loading-fn-page">Loaded content</div>;
        },
        { name: "loadingFnTest" },
        () => [
          loading(() => (
            <div data-testid="loading-fn-skeleton">Loading skeleton</div>
          )),
        ],
      ),
      path(
        "/loading-fn-client-test",
        async () => {
          await new Promise((r) => setTimeout(r, 200));
          return (
            <div data-testid="loading-fn-client-page">
              Loaded client content
            </div>
          );
        },
        { name: "loadingFnClientTest" },
        () => [loading(() => <LoadingFnSkeleton />)],
      ),
      path(
        "/loading-element-client-test",
        async () => {
          await new Promise((r) => setTimeout(r, 200));
          return (
            <div data-testid="loading-element-client-page">
              Loaded element client content
            </div>
          );
        },
        { name: "loadingElementClientTest" },
        () => [loading(<LoadingFnSkeleton />)],
      ),

      // parallel loader inheritance regression test
      include("/", parallelLoaderInheritPatterns),

      // parallel loader revalidation on orphan layout regression test
      include("/", parallelLoaderRevalPatterns),

      // PR #482 regression: parallel slot revalidate() fns survive sibling
      // action + nav (action pruned slot from client matched set, next nav
      // skipped revalidate fns)
      include("/", parallelRevalAfterActionPatterns, {
        name: "parallelRevalAfterAction",
      }),

      // Skip test patterns (prerender + static skip/error handling)
      include("/build-skip", buildSkipPatterns, { name: "buildSkip" }),

      // Prerender context test patterns (ctx.build, ctx.set/get, getParams context)
      include("/prerender-ctx", prerenderCtxPatterns, { name: "prerenderCtx" }),

      // Reverse auto-fill test patterns (parameterized include prefix)
      include("/reverse-autofill/:tenantId", reverseAutofillPatterns, {
        name: "reverseAutofill",
      }),

      // "use cache" directive test patterns (file-level, function-level, named profiles)
      include("/use-cache-test", useCachePatterns, { name: "useCacheTest" }),

      // Loader reverse test patterns (ctx.reverse inside loaders)
      include("/loader-reverse", loaderReversePatterns, {
        name: "loaderReverse",
      }),

      // Context clean test patterns (verify _rsc* params stripped from ctx)
      include("/ctx-clean", ctxCleanPatterns, { name: "ctxClean" }),

      // Loader cookie + RequestContext reverse test patterns
      include("/loader-cookie", loaderCookiePatterns, {
        name: "loaderCookie",
      }),

      // Action ctx.set → handler ctx.get test
      include("/action-ctx-set", actionCtxSetPatterns, {
        name: "actionCtxSet",
      }),

      // ctx.isAction() typed action matching in a revalidate predicate
      include("/is-action", isActionPatterns, {
        name: "isAction",
      }),

      // useParams survival across action → revalidation boundary
      include("/params-after-action", paramsAfterActionPatterns, {
        name: "paramsAfterAction",
      }),

      // Middleware wrapping test (middleware(fn, () => [...]) scoping)
      include("/middleware-wrapping", middlewareWrappingPatterns, {
        name: "middlewareWrapping",
      }),

      // Middleware chain integration test (global mw + action + route mw + layout + loader)
      include("/mw-chain", mwChainPatterns, { name: "mwChain" }),

      // Auth boundary test (route mw vs global mw, actions, response routes)
      include("/auth-boundary", authBoundaryPatterns, {
        name: "authBoundary",
      }),

      // Content ownership / negotiation edge cases
      include("/content-ownership", contentOwnershipPatterns, {
        name: "contentOwnership",
      }),

      // Cache isolation tests (query, auth, condition)
      include("/cache-isolation", cacheIsolationPatterns, {
        name: "cacheIsolation",
      }),

      // Cache-tag invalidation tests (cacheTag / updateTag / cache({ tags }))
      include("/cache-tag-test", cacheTagPatterns, { name: "cacheTag" }),

      // ALS scope propagation tests (request, render, intercept scopes)
      include("/als-scope", alsScopePatterns, { name: "alsScope" }),

      // Revalidation contract fixture: consumer reruns without producer rerun,
      // so upstream ctx.set() data is missing on the action follow-up.
      include("/revalidation-contract", revalidationContractPatterns, {
        name: "",
      }),

      // Action redirect revalidation test patterns
      include(
        "/action-redirect-revalidation",
        actionRedirectRevalidationPatterns,
        {
          name: "actionRedirectRevalidation",
        },
      ),

      // Hash navigation test patterns (hash-only links bypass SPA router)
      include("/hash-navigation", hashNavigationPatterns, {
        name: "hashNavigation",
      }),

      // Link behavior test patterns (interception, prefetch strategies)
      include("/link-behavior", linkBehaviorPatterns, {
        name: "linkBehavior",
      }),

      // Prerender with parent route params (locale in include prefix)
      include("/:locale", prerenderLocalePatterns, { name: "locale" }),

      // Include under layout with middleware — tests that layout middleware
      // is applied to routes inside include() even when include() is the
      // only child of the layout (the hasRoutesInItem fix).
      layout(IncludeMwLayout, () => [
        middleware(async (ctx, next) => {
          ctx.set("includeLayoutMw", "applied");
          await next();
          ctx.header("X-Include-Layout-Middleware", "applied");
        }),
        include("/include-mw-test", includeMiddlewarePatterns, {
          name: "includeMw",
        }),
      ]),

      // Optional include prefix regression coverage. The outer "/oi" static
      // segment is needed to avoid colliding with HomePage at "/"; the
      // optional locale lives at the include boundary so the joined patterns
      // exercise the include + optional path-helper join logic end-to-end.
      include("/oi/:locale?", optionalIncludePatterns, {
        name: "optionalInclude",
      }),
      include("/coi/:locale(en|gb)?", constrainedOptionalIncludePatterns, {
        name: "constrainedOptionalInclude",
      }),

      // Shop playground page
      path(
        "/shop-playground",
        () => (
          <div data-testid="shop-playground-page">
            <h1>Shop API Playground</h1>
            <ShopPlayground baseUrl="/api/shop" />
          </div>
        ),
        { name: "shopPlayground" },
      ),

      // Module-level reverse() test endpoint — returns results computed at
      // module load time (before lazy includes resolve) via NamedRoutes fallback
      path.json(
        "/reverse-fallback-test",
        async (): Promise<Record<string, string>> => {
          const { moduleLevelReverseResults } = await import("./router.js");
          return moduleLevelReverseResults;
        },
        { name: "reverseFallbackTest" },
      ),

      // Runtime manifest test endpoint — reads the cached manifest directly.
      // Used by HMR tests to verify the runtime manifest stays in sync with
      // the generated types file after route changes. Uses internal APIs
      // (getGlobalRouteMap) because ctx.reverse() resolves from a closure-
      // captured route map that doesn't update on HMR.
      path.json(
        "/__debug/reverse-test",
        async (ctx): Promise<Record<string, string | null>> => {
          const url = new URL(ctx.request.url);
          const names = url.searchParams.getAll("name");
          const result: Record<string, string | null> = {};
          const serverMod = await import("@rangojs/router/server");
          const routeMap = serverMod.getGlobalRouteMap();
          for (const name of names) {
            result[name] = routeMap[name] ?? null;
          }
          return result;
        },
      ),

      // Test utils: read onError log (non-destructive).
      // Imports from error-log.js (not router.js) so we can use a static
      // import and avoid the dynamic-import / module-graph race that
      // occasionally returned an empty log under concurrent SSR load.
      path.json(
        "/__test/last-error",
        () => (onErrorLog.length > 0 ? [...onErrorLog] : null),
        { name: "testLastError" },
      ),
      // Test utils: clear onError log
      path.json(
        "/__test/clear-error-log",
        () => {
          clearOnErrorLog();
          return { cleared: true };
        },
        { name: "testClearErrorLog" },
      ),

      // Test utils: response route that throws to trigger onError with phase="handler"
      path.json(
        "/__test/throw-handler-error",
        () => {
          throw new Error("Handler error for onError test");
        },
        { name: "testThrowHandlerError" },
      ),

      // Test utils: expose loader $$id values for e2e fetchable guard tests.
      // Production builds hash IDs, so tests need to discover them at runtime.
      path.json(
        "/__test/loader-ids",
        async () => {
          const { FetchableTestLoader, ProductsLoader, ProtectedLoader } =
            await import("./loaders.js");
          return {
            fetchable: (FetchableTestLoader as any).$$id,
            nonFetchable: (ProductsLoader as any).$$id,
            withMiddleware: (ProtectedLoader as any).$$id,
          };
        },
        { name: "testLoaderIds" },
      ),

      // Manifest cache test route (its DSL handler increments a counter)
      include("/manifest-cache-test", manifestCacheTestPatterns, {
        name: "manifestCacheTest",
      }),

      // Manifest cache test: read the handler execution counter.
      // The DSL handler in manifestCacheTestPatterns increments a counter
      // each time loadManifest() runs it. After the first request the
      // manifest is cached, so subsequent requests should NOT increment it.
      path.json(
        "/__test/manifest-cache-counter",
        async () => {
          const mod = await import("./manifest-cache-probe.js");
          return { handlerExecutions: mod.handlerExecutions };
        },
        { name: "testManifestCacheCounter" },
      ),

      // Prerender manifest introspection: returns entry count for a given
      // route name so e2e tests can verify which params were prerendered.
      path.json(
        "/__test/prerender-manifest-entries",
        async (ctx) => {
          const routeName = ctx.searchParams.get("route");
          if (!routeName) return { error: "missing route param" };
          if (!globalThis.__loadPrerenderManifestModule)
            return { available: false, count: 0 };
          const mod = await globalThis.__loadPrerenderManifestModule();
          const keys = Object.keys(mod.default).filter((k) =>
            k.startsWith(routeName + "/"),
          );
          return { available: true, count: keys.length };
        },
        { name: "testPrerenderManifestEntries" },
      ),

      // Content negotiation test: RSC + JSON + MD on same URL
      path(
        "/negotiate-test",
        () => (
          <div data-testid="negotiate-rsc-page">
            <h1>Negotiate Test RSC</h1>
          </div>
        ),
        { name: "negotiateTest" },
      ),
      path.json(
        "/negotiate-test",
        () => ({
          source: "json",
        }),
        { name: "negotiateTestJson" },
      ),
      path.md(
        "/negotiate-test",
        () => "# Negotiate Test MD\n\nMarkdown content.",
        { name: "negotiateTestMd" },
      ),

      // Response handler auto-wrap + ctx.header()/cookies().set() tests
      path.md(
        "/response-wrap/auto",
        (ctx) => {
          return `# Auto-wrapped\n\nParam: ${ctx.searchParams.get("q") ?? "none"}`;
        },
        { name: "responseWrapAuto" },
      ),
      path.md(
        "/response-wrap/with-headers",
        (ctx) => {
          ctx.header("X-Custom", "from-md-handler");
          ctx.header("Cache-Control", "public, max-age=3600");
          cookies().set("md-visited", "true", { path: "/", maxAge: 86400 });
          return `# With Headers\n\nHeaders set via ctx.header().`;
        },
        { name: "responseWrapWithHeaders" },
      ),
      path.json(
        "/response-wrap/json-headers",
        (ctx) => {
          ctx.header("X-Api-Version", "v2");
          cookies().set("api-session", "abc123", { httpOnly: true, path: "/" });
          return { source: "json", version: 2 };
        },
        { name: "responseWrapJsonHeaders" },
      ),
      path.json(
        "/response-wrap/nested-promise",
        // Regression: an object with a nested UNAWAITED Promise (the
        // forgotten-await footgun, e.g. `{ user: db.getUser(id) }`). The runtime
        // guard must throw (-> 500) instead of silently emitting {"value":{}}.
        () => ({ value: Promise.resolve("resolved-late") }),
        { name: "responseWrapNestedPromise" },
      ),
      path.text(
        "/response-wrap/text",
        (ctx) => {
          ctx.header("X-Text-Custom", "hello");
          return "plain text response";
        },
        { name: "responseWrapText" },
      ),
      path.html("/response-wrap/html", () => "<h1>html response</h1>", {
        name: "responseWrapHtml",
      }),
      path.xml("/response-wrap/xml", () => "<root>xml</root>", {
        name: "responseWrapXml",
      }),
      path.md(
        "/response-wrap/custom-response",
        (ctx) => {
          return new Response(`# Custom\n\nWith custom headers.`, {
            status: 200,
            headers: {
              "Content-Type": "text/markdown;charset=utf-8",
              "Cache-Control": "public, max-age=3600",
              "X-Custom": "hello",
            },
          });
        },
        { name: "responseWrapCustom" },
      ),

      // Middleware + response routes: nested middleware passing variables
      path.json(
        "/response-mw/nested",
        (ctx) => {
          const outer = ctx.get("outerMw") as string;
          const inner = ctx.get("innerMw") as string;
          return { outer, inner };
        },
        { name: "responseMwNested" },
        () => [
          middleware(async (ctx, next) => {
            ctx.set("outerMw", "outer-value");
            ctx.header("X-Outer-Mw", "applied");
            await next();
            ctx.header("X-Outer-After", "after-handler");
          }),
          middleware(async (ctx, next) => {
            const fromOuter = ctx.get("outerMw");
            ctx.set("innerMw", `inner-saw-${fromOuter}`);
            ctx.header("X-Inner-Mw", "applied");
            await next();
          }),
        ],
      ),
      path.md(
        "/response-mw/md-with-mw",
        (ctx) => {
          const role = ctx.get("role") as string;
          return `# Middleware MD\n\nRole: ${role}`;
        },
        { name: "responseMwMd" },
        () => [
          middleware(async (ctx, next) => {
            ctx.set("role", "admin");
            cookies().set("mw-role", "admin", { path: "/" });
            await next();
          }),
        ],
      ),

      // Layout wrapping response routes: layout should be ignored, response route works
      layout(
        () => <div data-testid="layout-wrap">LAYOUT</div>,
        () => [
          path.json(
            "/response-in-layout",
            () => ({
              source: "json-in-layout",
            }),
            { name: "responseInLayout" },
          ),
          path.md("/response-in-layout-md", () => "# MD in Layout", {
            name: "responseInLayoutMd",
          }),
        ],
      ),

      // Content negotiation test: JSON defined first, then RSC
      // For */* fallback, JSON should win (definition order)
      path.json(
        "/negotiate-test-json-first",
        () => ({
          source: "json",
        }),
        { name: "negotiateJsonFirst" },
      ),
      path(
        "/negotiate-test-json-first",
        () => (
          <div data-testid="negotiate-json-first-rsc-page">
            <h1>Negotiate JSON-First RSC</h1>
          </div>
        ),
        { name: "negotiateJsonFirstRsc" },
      ),

      // Content negotiation + variant-specific middleware test:
      // Each variant has its own middleware that sets a distinct header.
      path(
        "/negotiate-mw-test",
        () => (
          <div data-testid="negotiate-mw-rsc-page">
            <h1>Negotiate MW RSC</h1>
          </div>
        ),
        { name: "negotiateMwRsc" },
        () => [
          middleware(async (ctx, next) => {
            await next();
            ctx.header("X-Variant-Mw", "html");
          }),
        ],
      ),
      path.json(
        "/negotiate-mw-test",
        () => ({ source: "json" }),
        { name: "negotiateMwJson" },
        () => [
          middleware(async (ctx, next) => {
            await next();
            ctx.header("X-Variant-Mw", "json");
          }),
        ],
      ),

      // SSR stream mode test route
      include("/", streamModePatterns, { name: "" }),

      // Context dedup test (third-party package with "use client" + createContext)
      include("/context-dedup", contextDedupPatterns, {
        name: "contextDedup",
      }),

      // @meta parallel slot pattern (handles from parallel slots)
      include("/parallel-meta", parallelMetaPatterns, {
        name: "parallelMeta",
      }),

      // Layout-mounted parallel slot that conditionally pushes Meta —
      // exercises the stale-handle-bucket cleanup on slot revalidation
      // when the slot returns null without pushing.
      include("/parallel-meta-stale", parallelMetaStalePatterns, {
        name: "parallelMetaStale",
      }),

      // notFound() without a notFoundBoundary — should render 404, not error
      path(
        "/not-found-no-boundary",
        () => {
          notFound("This item does not exist");
        },
        { name: "notFoundNoBoundary" },
      ),

      // cache() scope guard tests (header/cookie/status blocked, set allowed)
      include("/cache-scope-guard", cacheScopeGuardPatterns, {
        name: "cacheScopeGuard",
      }),

      // rendered() barrier tests (loader reads handle data after handlers settle)
      include("/rendered-barrier", renderedBarrierPatterns, {
        name: "renderedBarrier",
      }),

      // Colocated loader + handle + prerender in same file (client import test)
      include("/colocated-lp", colocatedLoaderPrerenderPatterns, {
        name: "colocatedLp",
      }),

      ...(import.meta.env.DEV
        ? [
            path("/__dev/info", devInfoHandler),
            include("/__dev/debug", devDebugPatterns),
          ]
        : []),
    ]),
  ],
);
