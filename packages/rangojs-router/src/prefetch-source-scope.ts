/**
 * The source group of a prefetch answer a revalidate() rule kept from the
 * page being left (#1331, rango-t242). Shared by the server, which reports
 * the group in `x-rsc-prefetch-scope: params; <label>` (rsc/rsc-rendering.ts),
 * and the browser, which stores the answer under that label and rebuilds it
 * from the page on screen to look it up (browser/prefetch/cache.ts).
 * Dependency free, like prefetch-markers.ts: the browser must not import the
 * server modules that record the reads (router/source-reads.ts).
 *
 * Why a label is enough: a rule's decision depends on the source page only
 * through what it read. Two pages with equal values of everything the kept
 * rules read run every rule the same way, so one answer serves both.
 */

/** What the revalidate() rules that kept a segment read of the source page. */
export interface SourceReads {
  /**
   * `currentParams` was read. Its key set is then part of the group: a rule
   * can test a key's presence (`in`, `Object.keys`) without reading a value.
   */
  keys: boolean;
  /** Each `currentParams` value read; a spread or JSON.stringify reads all. */
  params: Set<string>;
  /** `fromRouteName` was read. */
  route: boolean;
  /** `currentUrl` was read: the answer is the exact page's. */
  url: boolean;
}

/** The page a label describes: the source on the server, the screen in the browser. */
export interface SourcePage {
  params: Readonly<Record<string, string | undefined>>;
  /** The public route name (route-name.ts publicRouteName). */
  routeName: string | undefined;
}

/** What a label reads, without the values: one per kind of rule set. */
export interface SourceShape {
  keys: boolean;
  route: boolean;
  /** Sorted. */
  names: readonly string[];
}

/** `x-rsc-prefetch-scope` value prefix of a params-grouped answer. */
export const PARAMS_SCOPE_PREFIX = "params; ";

export function createSourceReads(): SourceReads {
  return { keys: false, params: new Set(), route: false, url: false };
}

export function hasSourceReads(reads: SourceReads): boolean {
  return reads.keys || reads.route || reads.url || reads.params.size > 0;
}

/** Union `from` into `into`. */
export function mergeSourceReads(into: SourceReads, from: SourceReads): void {
  into.keys ||= from.keys;
  into.route ||= from.route;
  into.url ||= from.url;
  for (const name of from.params) into.params.add(name);
}

export function shapeOfReads(reads: SourceReads): SourceShape {
  return {
    keys: reads.keys || reads.params.size > 0,
    route: reads.route,
    names: [...reads.params].sort(),
  };
}

/**
 * The label of `page` under `shape`: `&`-joined, `$k=<keys>` first, then
 * `$r[=<route>]`, then `<name>[=<value>]` per read param, sorted. A missing
 * value has no `=`. Names and values are URI-encoded, so a `$` entry never
 * collides with a param (encodeURIComponent encodes `$`).
 */
export function formatSourceLabel(
  shape: SourceShape,
  page: SourcePage,
): string {
  const parts: string[] = [];
  if (shape.keys) {
    parts.push(
      "$k=" + Object.keys(page.params).sort().map(encodeURIComponent).join(","),
    );
  }
  if (shape.route) parts.push(entry("$r", page.routeName));
  for (const name of shape.names) {
    parts.push(entry(encodeURIComponent(name), page.params[name]));
  }
  return parts.join("&");
}

function entry(name: string, value: string | undefined): string {
  return value === undefined ? name : name + "=" + encodeURIComponent(value);
}

/**
 * The label of an `x-rsc-prefetch-scope` value, or undefined when the value
 * is not a params scope.
 */
export function paramsScopeLabel(
  header: string | null | undefined,
): string | undefined {
  if (!header?.startsWith(PARAMS_SCOPE_PREFIX)) return undefined;
  return header.slice(PARAMS_SCOPE_PREFIX.length);
}

/** The shape of a label formatSourceLabel wrote. */
export function parseSourceShape(label: string): SourceShape {
  let keys = false;
  let route = false;
  const names: string[] = [];
  for (const part of label.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const name = eq === -1 ? part : part.slice(0, eq);
    if (name === "$k") keys = true;
    else if (name === "$r") route = true;
    else names.push(decodeURIComponent(name));
  }
  return { keys, route, names: names.sort() };
}

/** A stable id of a shape, for indexing. */
export function sourceShapeId(shape: SourceShape): string {
  return (
    (shape.keys ? "k" : "") +
    (shape.route ? "r" : "") +
    ":" +
    shape.names.map(encodeURIComponent).join(",")
  );
}
