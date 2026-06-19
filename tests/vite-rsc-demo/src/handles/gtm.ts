import { createHandle } from "@rangojs/router";

/**
 * Google Tag Manager integration, wired the idiomatic Rango way: a layout
 * handler pushes the container id + page tagging into the Gtm handle; the client
 * <GtmScript> in the document head reads it via useHandle(Gtm) and injects the
 * GTM scripts with the request CSP nonce; <GtmPageViews> emits page_view on soft
 * navigation; ecommerce events come from the route's loader data and user
 * interactions.
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
 * collectGtm folds segment entries parent -> child: containerId is last-wins
 * (the root layout sets it), and page is shallow-merged so a nested route can add
 * fields (content_group, custom dimensions) on top of the layout's page.
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

/** What a route/layout handler pushes via ctx.use(Gtm). */
export interface GtmEntry {
  containerId?: string;
  page?: GtmPageInfo;
}

/** The merged value read on the client via useHandle(Gtm). */
export interface GtmConfig {
  containerId?: string;
  page: GtmPageInfo;
}

function collectGtm(segments: GtmEntry[][]): GtmConfig {
  let containerId: string | undefined;
  const page: GtmPageInfo = {};
  for (const segment of segments) {
    for (const entry of segment) {
      if (entry.containerId !== undefined) containerId = entry.containerId;
      if (entry.page) Object.assign(page, entry.page);
    }
  }
  return { containerId, page };
}

/**
 * GTM handle. The $$id is injected by the Vite plugin from file path + export
 * name (same as the demo's Breadcrumbs handle); do not pass one manually.
 */
export const Gtm = createHandle<GtmEntry, GtmConfig>(collectGtm);

/** Default demo container id. Placeholder — see the module doc (DEMO LIMITATION). */
export const DEFAULT_GTM_ID = "GTM-DEMO123";

/**
 * Escape a JSON string for safe embedding inside an inline <script>, mirroring
 * the router-internal escapeJsonForScript (which is not a public export). A raw
 * "</script>" would close the tag early; escaping "<", ">", "&" to \uXXXX keeps
 * the payload valid JSON and a valid JS string literal that re-parses identically.
 */
function escapeForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

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
 * The static, handle-derived part of a page_view: page_path plus any pass-through
 * params (content_group, custom dimensions). The runtime fields (page_location,
 * page_title, page_referrer) are added at the push site. Shared by the SSR inline
 * init and the client soft-nav effect so both emit an identical field set.
 *
 * Reserved keys are dropped from extras so a stray handle push (e.g. a route
 * pushing `page: { event: "x" }` or `page: { page_title: "..." }`) cannot
 * override the event name, page_path, or the runtime page_location/page_title/
 * page_referrer.
 */
export function pageViewTagging(page: GtmPageInfo): GtmDataLayerEvent {
  const { path, ...extras } = page;
  const result: GtmDataLayerEvent = {};
  if (path !== undefined) result.page_path = path;
  for (const [key, value] of Object.entries(extras)) {
    if (!RESERVED_PAGE_VIEW_KEYS.has(key)) result[key] = value;
  }
  return result;
}

/**
 * Generate the inline GTM bootstrap (Google's canonical snippet, parameterized):
 * initialise window.dataLayer, fire the gtm.js start event, emit the FIRST
 * page_view, then inject the gtm.js loader.
 *
 * The loader is injected by THIS (nonced) inline script rather than rendered as a
 * declarative <script async>, on purpose: React 19 hoists a declarative async
 * script to the TOP of <head>, ABOVE this inline bootstrap, so gtm.js could
 * execute before dataLayer exists. Injecting it here guarantees the
 * dataLayer-before-gtm.js contract regardless of document order. Under
 * 'strict-dynamic' the nonced inline script vouches for the script it creates,
 * so the injected loader needs no nonce of its own.
 *
 * Deterministic so the rendered string is byte-identical between SSR and
 * hydration — every dynamic value is a runtime expression (location.href,
 * document.title, new Date()) or a statically-interpolated constant, never a
 * value that differs per render.
 */
export function generateGtmInit(
  containerId: string,
  page: GtmPageInfo,
): string {
  const tagging = escapeForScript(JSON.stringify(pageViewTagging(page)));
  const id = escapeForScript(JSON.stringify(containerId));
  return [
    "window.dataLayer=window.dataLayer||[];",
    'window.dataLayer.push({"gtm.start":new Date().getTime(),event:"gtm.js"});',
    `window.dataLayer.push(Object.assign({event:"page_view",page_location:location.href,page_title:document.title,page_referrer:document.referrer},${tagging}));`,
    `(function(d,s,i){var j=d.createElement(s);j.async=true;j.src="https://www.googletagmanager.com/gtm.js?id="+encodeURIComponent(i);var f=d.getElementsByTagName(s)[0];f.parentNode.insertBefore(j,f);})(document,"script",${id});`,
  ].join("");
}

/** GTM <noscript> iframe URL for the given container id. */
export function gtmNoScriptSrc(containerId: string): string {
  return `https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(
    containerId,
  )}`;
}
