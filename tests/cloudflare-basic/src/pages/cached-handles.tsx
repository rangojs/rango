import type { HandlerContext } from "@rangojs/router";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

/**
 * Regression fixture for the cached-handle serialization bug. The route is
 * cache()-wrapped, and its handler pushes a breadcrumb whose `content` is a
 * Promise<ReactNode> — the exact value shape JSON.stringify destroys (Promise ->
 * {}). Before the fix, persisting to the Cloudflare cache flattened that content,
 * so on a cache HIT the breadcrumb content vanished. After the fix the handle map
 * is Flight-encoded, so the content survives and still renders on a HIT.
 *
 * The nonce is generated per server render and embedded in BOTH the page body
 * and the breadcrumb content. A cache HIT serves the stored render verbatim (the
 * handler does not re-run), so a stable nonce across visits proves the response
 * came from cache, and the content carrying that same nonce proves the handle
 * survived the round-trip.
 */
export function CachedHandlesPage(ctx: HandlerContext) {
  const breadcrumb = ctx.use(Breadcrumbs);
  const nonce = crypto.randomUUID();

  breadcrumb({ label: "Home", href: "/" });
  breadcrumb({
    label: "Cached",
    href: "/cached-handles",
    content: Promise.resolve(
      <span data-testid="ch-crumb-content">{`content-${nonce}`}</span>,
    ),
  });

  // BreadcrumbNav is rendered globally by NavLayout; it reads the pushed
  // Breadcrumbs handle and renders the Promise<ReactNode> content.
  return (
    <div data-testid="cached-handles-page">
      <span data-testid="ch-nonce">{nonce}</span>
    </div>
  );
}
