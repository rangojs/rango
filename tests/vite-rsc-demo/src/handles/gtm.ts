import { createHandle } from "@rangojs/router";

/**
 * Google Tag Manager integration, built on the router's first-class primitives:
 *
 * - The inline GTM BOOTSTRAP is pushed into the built-in `Script` handle
 *   (ctx.use(Script)) by the root layout and rendered by `<Scripts/>` in
 *   RootLayout's <head> with the request CSP nonce applied automatically. A route
 *   may override it by reusing the "gtm" Script id (see urls/gtm.tsx) to bake
 *   per-route tagging (content_group) into the FIRST page_view server-side.
 * - This `Gtm` handle carries per-route page tagging (content_group, ...) for the
 *   SOFT-navigation page_view, read by the client `<GtmPageViews>`.
 * - generateGtmInit builds the bootstrap string; pageViewTagging shapes the
 *   soft-nav page_view; ecommerce events come from loader data + interactions.
 *
 * SCOPE — this wires the PRODUCER side (the dataLayer). It does NOT, by itself,
 * send anything to GA4. To make these events flow, the GTM container must be
 * configured:
 *   - a Custom Event trigger for "page_view" (and "view_item" / "add_to_cart"),
 *   - a GA4 Configuration/Event tag bound to those triggers,
 *   - Data Layer Variables mapping page_path / page_title / page_location /
 *     page_referrer / content_group / ecommerce into the tag.
 *   See https://developers.google.com/tag-platform/tag-manager/datalayer and
 *   https://developers.google.com/analytics/devguides/collection/ga4/ecommerce.
 *
 * NO DOUBLE-COUNTING — this app sends MANUAL page_views (one on first render via
 * the inline bootstrap, one per soft navigation via <GtmPageViews>). The GA4 tag
 * MUST therefore have "Send a page view event when this configuration loads"
 * turned OFF and "Page changes based on History events" (Enhanced Measurement
 * history tracking) disabled — otherwise GA4 double-counts SPA navigations. See
 * https://developers.google.com/analytics/devguides/collection/ga4/single-page-applications.
 *
 * DEMO LIMITATION — DEFAULT_GTM_ID is a placeholder. The tests verify the
 * producer side (markup, head placement, nonce, dataLayer queue + event shapes),
 * not that a real GTM container loads and forwards events to GA4.
 *
 * collectGtm folds segment entries parent -> child: page is shallow-merged so a
 * nested route can add fields (content_group, custom dimensions) on top.
 */

/** A single dataLayer event object pushed to window.dataLayer. */
export type GtmDataLayerEvent = Record<string, unknown>;

declare global {
  interface Window {
    dataLayer?: GtmDataLayerEvent[];
  }
}

/**
 * Page-level tagging accumulated across route segments and emitted on EVERY
 * page_view. `path` becomes page_path; any other key (content_group, custom
 * dimensions) is passed through verbatim. page_title / page_location /
 * page_referrer are NOT here — they are runtime values read from the live
 * document at the push site so they always reflect the rendered page.
 */
export interface GtmPageInfo {
  /** Rendered path (pathname + search), emitted as page_path. */
  path?: string;
  /** Arbitrary extra dataLayer params (content_group, custom dimensions, ...). */
  [key: string]: unknown;
}

/** What a route handler pushes via ctx.use(Gtm) (the container id is a build
 * constant, so the handle only carries per-route page tagging). */
export interface GtmEntry {
  page?: GtmPageInfo;
}

/** The merged value read on the client via useHandle(Gtm). */
export interface GtmConfig {
  page: GtmPageInfo;
}

function collectGtm(segments: GtmEntry[][]): GtmConfig {
  const page: GtmPageInfo = {};
  for (const segment of segments) {
    for (const entry of segment) {
      if (entry.page) Object.assign(page, entry.page);
    }
  }
  return { page };
}

/**
 * GTM handle. The $$id is injected by the Vite plugin from file path + export
 * name (same as the demo's Breadcrumbs handle); do not pass one manually.
 */
export const Gtm = createHandle<GtmEntry, GtmConfig>(collectGtm);

/** Default demo container id. Placeholder — see the module doc (DEMO LIMITATION). */
export const DEFAULT_GTM_ID = "GTM-DEMO123";

// page_view fields that are owned by the framework (the event name, page_path
// from `path`, and the runtime fields added at the push site). Arbitrary handle
// extras must not clobber these.
const RESERVED_PAGE_VIEW_KEYS = new Set([
  "event",
  "page_path",
  "page_location",
  "page_title",
  "page_referrer",
]);

/**
 * Drop framework-owned keys from a tagging bag so extras can never override the
 * event name, page_path, or the runtime page_location/page_title/page_referrer.
 * Shared by BOTH page_view paths — the soft-nav effect (pageViewTagging) and the
 * hard-load inline bootstrap (generateGtmInit) — so they sanitize identically.
 */
function stripReservedKeys(
  extras: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(extras).filter(([key]) => !RESERVED_PAGE_VIEW_KEYS.has(key)),
  );
}

/**
 * The static, handle-derived part of a page_view: page_path plus any pass-through
 * params (content_group, custom dimensions). The runtime fields (page_location,
 * page_title, page_referrer) are added at the push site. Shared by the SSR inline
 * init and the client soft-nav effect so both emit an identical field set.
 */
export function pageViewTagging(page: GtmPageInfo): GtmDataLayerEvent {
  const { path, ...extras } = page;
  return {
    ...(path !== undefined ? { page_path: path } : {}),
    ...stripReservedKeys(extras),
  };
}

/**
 * Generate the inline GTM bootstrap (Google's canonical snippet, parameterized):
 * initialise window.dataLayer, fire the gtm.js start event, emit the FIRST
 * page_view, then inject the gtm.js loader. Pushed into the built-in Script
 * handle (ctx.use(Script)) and rendered by <Scripts/>.
 *
 * The loader is injected by THIS inline script rather than emitted as a
 * declarative <script async>, on purpose: React 19 hoists a declarative async
 * script to the TOP of <head>, ABOVE this bootstrap, so gtm.js could execute
 * before dataLayer exists. Injecting it here guarantees the dataLayer-before-
 * gtm.js contract; under 'strict-dynamic' the nonced inline script (the nonce is
 * applied by <Scripts/>) vouches for the script it creates.
 *
 * The page_view's location/title/referrer are RUNTIME expressions (identical for
 * every request). `extras` (e.g. { content_group }) is baked server-side by the
 * pushing handler: a route can override the layout's bootstrap by reusing the
 * Script `id`, so per-route tagging lands on the FIRST (hard-load) page_view —
 * which a head-only server component cannot do. Reserved keys are stripped from
 * `extras` (same logic as the soft-nav path) so they cannot override the runtime
 * fields baked into `runtime` below.
 *
 * Returns raw JS; no manual escaping is needed because <Scripts/> escapes the
 * inline body against "</script>" breakout when it renders it.
 */
export function generateGtmInit(
  containerId: string,
  extras?: Record<string, unknown>,
): string {
  const id = JSON.stringify(containerId);
  const runtime =
    '{event:"page_view",page_location:location.href,page_path:location.pathname+location.search,page_title:document.title,page_referrer:document.referrer}';
  const safeExtras = extras ? stripReservedKeys(extras) : {};
  const pageView =
    Object.keys(safeExtras).length > 0
      ? `Object.assign(${runtime},${JSON.stringify(safeExtras)})`
      : runtime;
  return [
    "window.dataLayer=window.dataLayer||[];",
    'window.dataLayer.push({"gtm.start":new Date().getTime(),event:"gtm.js"});',
    `window.dataLayer.push(${pageView});`,
    `(function(d,s,i){var j=d.createElement(s);j.async=true;j.src="https://www.googletagmanager.com/gtm.js?id="+encodeURIComponent(i);var f=d.getElementsByTagName(s)[0];f.parentNode.insertBefore(j,f);})(document,"script",${id});`,
  ].join("");
}

/** GTM <noscript> iframe URL for the given container id. */
export function gtmNoScriptSrc(containerId: string): string {
  return `https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(
    containerId,
  )}`;
}
