import type { HandlerContext } from "@rangojs/router";
import { BasketButton } from "../components/BasketButton.js";
import { CfPhgHole } from "../components/CfPhgHole.js";
import { CfPhgCookieWriterLoader } from "../loaders/ppr-header-guard.js";

/**
 * ppr header-write guard fixtures (issue #713 doctrine: ppr is a
 * document-scoped cache() — in cached scenarios only middleware writes
 * headers). Guard routes carry their own errorBoundary in urls.tsx and are
 * only fetched by ppr-header-guard.test.ts.
 */

// HANDLER header write on a ppr route — the unified guard throws on every
// render (dev and prod, workerd).
export function CfPhgHandlerPage(ctx: HandlerContext) {
  ctx.headers.set("X-CF-PHG-Handler", "should-never-apply");
  return <div data-testid="cf-phg-handler-page">Should not render</div>;
}

// LOADER cookie write — the handler awaits the loader (no loading() hole) so
// the guard rejection surfaces at segment resolution on every render.
export async function CfPhgLoaderPage(ctx: HandlerContext) {
  await ctx.use(CfPhgCookieWriterLoader);
  return <div data-testid="cf-phg-loader-page">Should not render</div>;
}

// POSITIVE CONTROL shell: static text + a live loader hole.
export function CfPhgMwLivePage() {
  return (
    <main data-testid="cf-phg-mw-live-page">
      <p data-testid="cf-phg-mw-live-static">MW live shell</p>
      <CfPhgHole />
    </main>
  );
}

// Storefront basket shape: static shell + action button + live hole.
export function CfPprBasketPage() {
  return (
    <main data-testid="cf-ppr-basket-page">
      <p data-testid="cf-ppr-basket-static">Basket shell</p>
      <BasketButton />
      <CfPhgHole />
    </main>
  );
}
