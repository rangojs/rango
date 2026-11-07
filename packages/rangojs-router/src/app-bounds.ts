/**
 * App bounds: which paths of the current origin the app serving a document
 * owns, as the host routers that dispatched it decide (host/app-bounds.ts).
 *
 * Every app under createHostRouter() has its own router, client manifest and
 * React root, so a navigation into another app is a document load by nature.
 * The server answers a soft navigation into another app with X-RSC-Reload
 * (request-classification.ts, mode "app-switch"), but only after a wasted
 * round trip per prefetch and per click. The host router knows its mounts, so
 * the document payload carries the bounds (`RscMetadata.appBounds`) and the
 * client (browser/app-bounds.ts) sends an href it does not own straight to a
 * document navigation.
 *
 * The bounds are a hint, never the authority: a path they get wrong in either
 * direction still renders the right app (a soft attempt is answered with
 * X-RSC-Reload; a needless document load renders the same page).
 *
 * Shared by the server and the browser: no imports.
 */

/**
 * One host router's view, in its match order: `[pathPrefix, own]`. The first
 * entry whose prefix covers a path names the app that serves it; `""` covers
 * every path. A path no entry covers is not this app's.
 */
export type AppBoundsTable = readonly (readonly [string, boolean])[];

/**
 * Every host router on the request's way to the app, outermost first. A path
 * is the app's only when each table says so (a nested host router sees only
 * the paths its parent sent it).
 */
export type AppBounds = readonly AppBoundsTable[];

/**
 * Whether a host pattern's path prefix covers `pathname`: the whole path or a
 * whole leading segment run, case-sensitive; `""` covers every path. The rule
 * the host router matches with (host/pattern-matcher.ts matchPattern keeps a
 * copy, since the host entry imports no module a router imports).
 */
export function pathHasPrefix(pathname: string, prefix: string): boolean {
  return !prefix || pathname === prefix || pathname.startsWith(prefix + "/");
}

/** Whether `bounds` name `pathname` as another app's. */
export function isOtherAppPath(bounds: AppBounds, pathname: string): boolean {
  return bounds.some(
    (table) => !table.find(([prefix]) => pathHasPrefix(pathname, prefix))?.[1],
  );
}
