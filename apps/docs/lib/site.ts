export const siteName = "Vercel Shop";

export const homeTitle = "Production-ready Shopify storefront on Rango";

export const homeSubtitle = "Customize everything with AI agents";

export const homeDescription = `${homeTitle} ${homeSubtitle}`;

export const docsTitle = "Vercel Shop Documentation";

export const docsDescription =
  "Documentation for Vercel Shop — an agent-native, fast-by-default Shopify storefront built on Rango.";

export function getBaseUrl() {
  // SITE_URL is a wrangler var on the deployed worker (nodejs_compat
  // populates process.env from bindings). Unset locally, so dev and preview
  // fall back to the Vite origin.
  if (process.env.SITE_URL) {
    return new URL(process.env.SITE_URL);
  }

  return new URL(`http://localhost:${process.env.PORT ?? "5173"}`);
}
