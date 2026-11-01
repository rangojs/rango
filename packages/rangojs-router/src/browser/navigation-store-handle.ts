/**
 * A module-level handle to the active navigation store.
 *
 * The boot path (`rsc-router.tsx`) calls `createNavigationStore()` directly;
 * there is no global store singleton. This handle is the live reference for
 * code that needs the store but does not
 * receive it by argument: the jar-divergence observer (below) and the client
 * seat of `invalidateClientCache()` (added later).
 *
 * Dependency-light on purpose: it imports only the action fence, the
 * rango-state observers and the store type, so pulling it into the default
 * root entry does not drag the navigation store into bundles that previously
 * lacked it.
 */

import {
  noteStateRotation,
  noteStateWrite,
  setUnlandedWriteHandler,
} from "./action-fence.js";
import {
  setRangoStateObserver,
  setRangoStateWriteObserver,
} from "./rango-state.js";
import type { NavigationStore } from "./types.js";
import type { SourcePage } from "../prefetch-source-scope.js";

let registeredStore: NavigationStore | null = null;

/**
 * Register the active navigation store at boot, and wire the jar-divergence
 * observer: when a per-request cookie read detects an EXTERNAL rotation (a
 * sibling tab, a server `Set-Cookie`, or a cookie clear), mark this tab's
 * history cache stale. The history cache is not state-keyed, so the value
 * rotation alone does not reach it. No broadcast, no prefetch clear, no
 * re-rotation — the value already changed externally. A rotation seen while
 * an action is in flight is recorded on the fence: the action's landing then
 * sends the full broadcast (navigation-store.ts markCacheAsStaleAndBroadcast).
 *
 * A read that sees only the write part change (a server action's response,
 * in this tab or another) marks this tab's history entries and prefetches
 * stale, as a soft broadcast's receiver does: a tab the broadcast does not
 * reach would otherwise serve a prefetch made before the write as fresh.
 * While an action is in flight the write is recorded on the fence instead:
 * the action's landing marks every cache stale once (navigation-store.ts
 * markStaleSoftAndBroadcast), and when no landing does, the fence's drop
 * marks them.
 */
export function registerNavigationStore(store: NavigationStore): void {
  registeredStore = store;
  setRangoStateObserver(() => {
    noteStateRotation();
    registeredStore?.markHistoryCacheStale();
  });
  const markCachesStale = () => registeredStore?.markCachesStaleAfterWrite();
  setRangoStateWriteObserver(() => {
    if (!noteStateWrite()) markCachesStale();
  });
  setUnlandedWriteHandler(markCachesStale);
}

/** The active navigation store, or null before boot has registered it. */
export function getRegisteredStore(): NavigationStore | null {
  return registeredStore;
}

let readCommittedPage: (() => SourcePage) | null = null;

/**
 * Register the reader of the committed page's params and route name: the
 * router store's own state, which useParams reads (the event controller's
 * params, the displayed history entry's route name). Read by the prefetch
 * cache outside render, at request time, to look up an answer shared by the
 * pages with equal values of what a revalidate() rule read
 * (prefetch-source-scope.ts). A reader, not a copy: there is no second
 * source of truth for the params.
 */
export function registerCommittedPageReader(read: () => SourcePage): void {
  readCommittedPage = read;
}

/**
 * The boot reader (rsc-router.tsx): the event controller's params, which
 * useParams reads and only a commit sets (an optimistic clientUrls() frame
 * sets React context, not them), and the displayed entry's route name.
 */
export function committedPageOf(
  controller: { getParams(): Record<string, string> },
  store: Pick<NavigationStore, "getHistoryEntryMemory">,
): () => SourcePage {
  return () => ({
    params: controller.getParams(),
    routeName: store.getHistoryEntryMemory()?.routeName,
  });
}

/** The committed page, or null before boot has registered its reader. */
export function getCommittedPage(): SourcePage | null {
  return readCommittedPage ? readCommittedPage() : null;
}
