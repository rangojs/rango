import { WIRE } from "../wire-params.js";

/** The parameters of a partial request: a navigation, a prefetch or a JS server action. */
export interface PartialRequestInit {
  /** A JS server action's id: written as `_rsc_action` in place of `_rsc_partial`. */
  action?: string;
  /** The mounted segment ids the server diffs against. */
  segmentIds: readonly string[];
  /**
   * An empty `segmentIds`: "send" writes `_rsc_segments=` (navigation,
   * action), "omit" leaves it out (prefetch). The prefetch cache keys carry
   * the difference.
   */
  emptySegments: "send" | "omit";
  stale?: boolean;
  version?: string;
  routerId?: string;
  rewriteTarget?: string;
  fill?: boolean;
}

/**
 * Writes the partial-request parameters onto `url` in the one order every
 * sender uses. Navigation and prefetch cache keys are built from the result
 * (prefetch/cache.ts), so a navigation adopts a prefetch only while both
 * write identically: browser/__tests__/wire-urls.test.ts pins the strings.
 */
export function writePartialParams(url: URL, init: PartialRequestInit): URL {
  const params = url.searchParams;
  if (init.action !== undefined) params.set(WIRE.action, init.action);
  else params.set(WIRE.partial, "true");
  if (init.segmentIds.length > 0 || init.emptySegments === "send") {
    params.set(WIRE.segments, init.segmentIds.join(","));
  }
  if (init.stale) params.set(WIRE.stale, "true");
  if (init.version) params.set(WIRE.version, init.version);
  if (init.routerId) params.set(WIRE.routerId, init.routerId);
  if (init.rewriteTarget) params.set(WIRE.rewriteTarget, init.rewriteTarget);
  if (init.fill) params.set(WIRE.fill, "1");
  return url;
}
