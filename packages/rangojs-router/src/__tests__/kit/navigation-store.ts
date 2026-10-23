import {
  createNavigationStore,
  generateHistoryKey,
} from "../../browser/navigation-store.js";
import type { NavigationStore, ResolvedSegment } from "../../browser/types.js";

export interface KitNavigationStoreOptions {
  /** The current URL: a path or an absolute URL. Default `/`. */
  location?: string;
  /** The segment ids on screen. Default `[]`. */
  segmentIds?: string[];
  /** The current history key. Default: the one `location` gives. */
  historyKey?: string;
  /** Segments cached for the current history key, not stale. */
  segments?: ResolvedSegment[];
}

/**
 * A real `NavigationStore` from the production `createNavigationStore`.
 * Paths resolve against `http://localhost`. Cross-tab sync is off: it opens a
 * `BroadcastChannel`, which a unit test neither needs nor closes.
 */
export function makeNavigationStore(
  opts: KitNavigationStoreOptions = {},
): NavigationStore {
  const location = new URL(opts.location ?? "/", "http://localhost");
  return createNavigationStore({
    initialLocation: location,
    initialSegmentIds: opts.segmentIds,
    initialHistoryKey: opts.historyKey ?? generateHistoryKey(location.href),
    initialSegments: opts.segments,
    crossTabSync: false,
  });
}
