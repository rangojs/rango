import { urls, Meta, Breadcrumbs } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

/**
 * Test routes for @meta and @breadcrumbs parallel slot patterns.
 * Validates that parallel slots can set handles (Meta, Breadcrumbs)
 * and that the data is scoped to the parent segment.
 */
export const parallelMetaPatterns = urls(({ path, layout, parallel }) => [
  layout(
    (ctx) => {
      // Layout sets title template — child @meta slots override the title
      ctx.use(Meta)({
        title: { template: "%s | Test Store", default: "Test Store" },
      });
      ctx.use(Meta)({
        name: "description",
        content: "Default store description",
      });
      // Layout sets root breadcrumb
      ctx.use(Breadcrumbs)({ label: "Store", href: "/parallel-meta" });
      return (
        <div data-testid="parallel-meta-layout">
          <nav>
            <Link to="/parallel-meta" data-testid="pm-link-index">
              Index
            </Link>
            {" | "}
            <Link to="/parallel-meta/product-a" data-testid="pm-link-a">
              Product A
            </Link>
            {" | "}
            <Link to="/parallel-meta/product-b" data-testid="pm-link-b">
              Product B
            </Link>
          </nav>
          <Outlet />
        </div>
      );
    },
    () => [
      // Index route — no overrides, uses layout defaults
      path("/", () => <div data-testid="pm-index-page">Store Index</div>, {
        name: "index",
      }),

      // Product route — @meta and @breadcrumbs parallels override per route
      path(
        "/:slug",
        (ctx) => (
          <div data-testid="pm-product-page">
            <h1 data-testid="pm-product-name">Product: {ctx.params.slug}</h1>
          </div>
        ),
        { name: "product" },
        () => [
          parallel({
            "@meta": (ctx) => {
              const meta = ctx.use(Meta);
              const name = ctx.params.slug
                .split("-")
                .map((w: string) => w[0].toUpperCase() + w.slice(1))
                .join(" ");
              meta({ title: name });
              meta({ name: "description", content: `Details for ${name}` });
              meta({
                "script:ld+json": {
                  "@context": "https://schema.org",
                  "@type": "Product",
                  name,
                },
              });
              return null;
            },
            "@breadcrumbs": (ctx) => {
              const push = ctx.use(Breadcrumbs);
              const name = ctx.params.slug
                .split("-")
                .map((w: string) => w[0].toUpperCase() + w.slice(1))
                .join(" ");
              push({
                label: name,
                href: `/parallel-meta/${ctx.params.slug}`,
              });
              return null;
            },
          }),
        ],
      ),
    ],
  ),
]);
