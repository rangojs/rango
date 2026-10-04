export const siteName = "Rango";

export const homeTitle = "The Django-inspired RSC router for Vite";

export const homeSubtitle =
  "One explicit route tree, React Server Components, and correctness-first caching. Deploys to Cloudflare Workers and Vercel.";

export const homeDescription = `${homeTitle}. ${homeSubtitle}`;

export const docsTitle = "Rango Documentation";

export const docsDescription =
  "Documentation for Rango (@rangojs/router) — a Django-inspired React Server Components router for Vite.";

export function getBaseUrl() {
  // SITE_URL is a wrangler var on the deployed worker (nodejs_compat
  // populates process.env from bindings). Unset locally, so dev and preview
  // fall back to the Vite origin.
  if (process.env.SITE_URL) {
    return new URL(process.env.SITE_URL);
  }

  return new URL(`http://localhost:${process.env.PORT ?? "5173"}`);
}
