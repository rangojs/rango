import { createLoader, notFound, redirect } from "@rangojs/router";
import { products } from "@/handlers/shop/data.js";
import { Meta } from "@/handles/meta.js";
import { Breadcrumbs } from "@/handles/breadcrumbs.js";
import type { Product } from "@/handlers/shop/loaders/product.js";

export interface ClientShopProductSummary {
  slug: string;
  name: string;
  price: number;
  category: string;
}

/**
 * Product list for the clientUrls shop (/client-shop). Server-executed by
 * generated id like every projected clientUrls loader; the client module
 * imports only the definition. Small artificial delay so the index's inline
 * Suspense boundary is observable.
 */
export const ClientShopProductsLoader = createLoader(async (ctx) => {
  "use server";

  // Handle writes from the loader body (ctx.use = push, handler parity).
  // Land before the 400ms delay, so they usually beat the handler barrier;
  // either way delivery is async by design. (Not on the shared CartLoader:
  // the server shop consumes it too, and a crumb pushed there would leak
  // onto /shop routes.)
  ctx.use(Meta)({ title: "All products — Client Shop" });
  ctx.use(Breadcrumbs)({ label: "Client Shop", href: "/client-shop" });

  await new Promise((resolve) => setTimeout(resolve, 400));
  return products.map(
    ({ slug, name, price, category }): ClientShopProductSummary => ({
      slug,
      name,
      price,
      category,
    }),
  );
});

/**
 * "SSR-ed vs dynamic" is per-loader data availability at first-flush time.
 * This fetch carries the same simulated 2s latency as ProductLoader but is
 * cache()-backed via "use cache": a warm document load has the data READY
 * when Fizz flushes, so the product info section rides the FIRST paint —
 * fully SSR-ed — while the uncached RelatedProductsLoader on the same route
 * deliberately stays dynamic and streams behind its boundary. The choice of
 * which page parts are static vs dynamic is expressed per data source, not
 * per route.
 */
async function getProductCached(slug: string): Promise<Product> {
  "use cache";
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const product = products.find((p) => p.slug === slug);
  if (!product) {
    throw new Error(`Product not found: ${slug}`);
  }
  return product;
}

/**
 * Old slugs that moved. Data-dependent redirects live in loaders (thrown, so
 * every consumer of the loader inherits them); session/auth gates belong in
 * middleware.
 */
const LEGACY_SLUGS: Record<string, string> = {
  headphones: "wireless-headphones",
};

export const ClientShopProductLoader = createLoader(async (ctx) => {
  "use server";
  const slug = ctx.params.slug;
  if (!slug) {
    notFound("Product slug missing");
  }

  const movedTo = LEGACY_SLUGS[slug];
  if (movedTo) {
    throw redirect(`/client-shop/product/${movedTo}`);
  }

  // Existence check BEFORE the 2s cached fetch: the notFound() rejection is
  // near-instant, so on document loads it wins the race to first flush and
  // the response carries a real 404 status (plus the streamed 404 UI).
  if (!products.some((p) => p.slug === slug)) {
    notFound(`Product "${slug}" not found`);
  }

  const product = await getProductCached(slug);

  // Data-derived meta + breadcrumb trail, written where the data lives. Cold
  // cache: these land ~2s in and stream late (title/crumbs swap in —
  // acceptable async-by-design). Warm cache: they beat the handler barrier
  // and ride the SSR handle snapshot. Two pushes from one segment accumulate
  // in push order, so the trail renders "Client Shop › <product>".
  ctx.use(Meta)({ title: `${product.name} — Client Shop` });
  const pushCrumb = ctx.use(Breadcrumbs);
  pushCrumb({ label: "Client Shop", href: "/client-shop" });
  pushCrumb({
    label: product.name,
    href: `/client-shop/product/${product.slug}`,
  });

  return product;
});
