import type { HandlerContext } from "@rangojs/router";
import { ThemeToggle } from "../components/ThemeToggle.js";

/**
 * useTheme() on a document-cached page (#978), fetched only by
 * document-cache-theme.test.ts.
 *
 * - DocumentCacheThemePage opts into the document cache: its stored document
 *   carries the no-cookie default as initialTheme, whoever stored it.
 * - DocumentCacheThemeLivePage sends no s-maxage, so the cache never stores it
 *   and each visitor's render carries their own theme.
 */
export function DocumentCacheThemePage(ctx: HandlerContext) {
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  return (
    <main data-testid="cf-document-cache-theme-page">
      <ThemeToggle />
    </main>
  );
}

export function DocumentCacheThemeLivePage() {
  return (
    <main data-testid="cf-document-cache-theme-live-page">
      <ThemeToggle />
    </main>
  );
}
