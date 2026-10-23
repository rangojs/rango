import {
  createNavigationStore,
  generateHistoryKey,
  type NavigationStoreConfig,
} from "../../browser/navigation-store.js";
import type { NavigationStore } from "../../browser/types.js";

const DEFAULT_URL = "http://localhost/";

interface KitNavigationStoreOptions extends Omit<
  NavigationStoreConfig,
  "initialLocation"
> {
  /**
   * The document URL; a path resolves against http://localhost/. Without it
   * the store reads `window.location`, or http://localhost/ with no `window`,
   * as createNavigationStore does.
   */
  url?: string;
}

/**
 * A NavigationStore from createNavigationStore, booted the way
 * browser/rsc-router.tsx boots one: the history key comes from the document
 * URL and the on-screen segment ids from `initialSegments`, unless a test
 * passes its own. Cross-tab sync is off, as in testing/render-route.tsx: it
 * opens a BroadcastChannel no unit test hears.
 *
 * createNavigationStore reads `window.location` whenever a `window` exists, so
 * a test that stubs a `window` without `location.href` creates the store
 * first.
 */
export function makeNavigationStore(
  options: KitNavigationStoreOptions = {},
): NavigationStore {
  const { url, initialHistoryKey, initialSegmentIds, crossTabSync, ...config } =
    options;
  const href = url === undefined ? undefined : new URL(url, DEFAULT_URL).href;
  return createNavigationStore({
    ...config,
    initialLocation: href === undefined ? undefined : { href },
    initialHistoryKey: initialHistoryKey ?? generateHistoryKey(href),
    initialSegmentIds:
      initialSegmentIds ?? config.initialSegments?.map((s) => s.id),
    crossTabSync: crossTabSync ?? false,
  });
}
