/**
 * GTM helpers for the experimental-React app. This app's job is to confirm the
 * React-version-sensitive parts of the GTM integration (nonce stamping on head
 * scripts, hydration of a nonced inline script, hoisted loader, useNonce) have
 * no regressions on React's experimental channel. The richer handle + loader +
 * layout wiring (and the GTM container-config / no-double-counting guidance) is
 * documented in tests/vite-rsc-demo/src/handles/gtm.ts; here the container id is
 * a constant and the first page_view path comes from usePathname, to keep the
 * surface minimal and avoid disturbing the view-transition/prerender tests.
 */

export type GtmDataLayerEvent = Record<string, unknown>;

declare global {
  interface Window {
    dataLayer?: GtmDataLayerEvent[];
  }
}

export interface GtmPageInfo {
  /** Rendered path (pathname + search), emitted as page_path. */
  path?: string;
  /** Arbitrary extra dataLayer params. */
  [key: string]: unknown;
}

/** Demo GTM container id. */
export const DEFAULT_GTM_ID = "GTM-EXPERIMENTAL";

function escapeForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

const RESERVED_PAGE_VIEW_KEYS = new Set([
  "event",
  "page_path",
  "page_location",
  "page_title",
  "page_referrer",
]);

/**
 * Static, handle/route-derived page_view fields (page_path + extras). Reserved
 * keys are dropped so extras cannot override the event name or runtime fields.
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
 * Inline GTM bootstrap (Google's canonical snippet): init dataLayer, fire gtm.js
 * start, emit first page_view (runtime fields + static tagging), then INJECT the
 * gtm.js loader. Injecting it from the nonced inline script — instead of a
 * declarative <script async> — guarantees dataLayer exists before gtm.js runs
 * (React 19 would hoist a declarative async script above this bootstrap).
 * Deterministic so SSR and hydration produce a byte-identical string.
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

export function gtmNoScriptSrc(containerId: string): string {
  return `https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(
    containerId,
  )}`;
}
