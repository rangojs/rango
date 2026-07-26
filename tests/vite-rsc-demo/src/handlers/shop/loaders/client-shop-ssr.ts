import { createLoader, notFound } from "@rangojs/router";
import { products } from "@/handlers/shop/data.js";
import { Meta } from "@/handles/meta.js";

/**
 * Fixtures for loader(Def, { stream: "navigation" }) — the SSR-completeness
 * opt-in. Everything here lands AFTER a deliberate delay, so WITHOUT the flag
 * none of it could deterministically make the document: the Meta push would
 * lose the handler barrier (streaming via handlesLate, applied post-hydration),
 * the section would SSR as its Suspense fallback, and a thrown notFound()
 * would always lose the flush race (status 200). The flag makes the document
 * render await the loader, so all three are guaranteed in the SSR'd HTML.
 *
 * The sidecar MUST be slower than the awaited loader: both kick off in
 * parallel, so with equal delays the sidecar is coincidentally settled by
 * flush time and SSRs its data — the e2e needs it still pending at flush to
 * show its skeleton (the per-loader-scoping pin).
 */
export const SSR_AWAITED_DELAY_MS = 400;
export const SSR_SIDECAR_DELAY_MS = 1400;

export interface ClientShopSsrProduct {
  name: string;
  price: number;
}

export const ClientShopSsrProductLoader = createLoader(
  async (ctx): Promise<ClientShopSsrProduct> => {
    "use server";
    const slug = ctx.params.slug;

    await new Promise((resolve) => setTimeout(resolve, SSR_AWAITED_DELAY_MS));

    // Existence check AFTER the delay — the opposite of ClientShopProductLoader,
    // whose near-instant throw wins the flush race opportunistically. This
    // rejection can only produce a real 404 status through the awaited path.
    const product = products.find((p) => p.slug === slug);
    if (!product) {
      notFound(`Product "${slug}" not found`);
    }

    // Pushed after the delay too: only the document await puts it in the SSR
    // handle snapshot (MetaTags in the head); on navigations it streams.
    ctx.use(Meta)({ title: `${product.name} — SSR complete` });

    return { name: product.name, price: product.price };
  },
);

/**
 * Slower and NOT flagged — pins the per-loader scoping: the awaited sibling
 * must not drag this one into the pre-flush await, so its section still
 * SSRs as its Suspense fallback and streams in.
 */
export const ClientShopSsrSidecarLoader = createLoader(
  async (): Promise<{ note: string }> => {
    "use server";
    await new Promise((resolve) => setTimeout(resolve, SSR_SIDECAR_DELAY_MS));
    return { note: "streamed sidecar data" };
  },
);
