import type { EventController } from "./event-controller.js";
import type { HandleData, NavigationStore } from "./types.js";
import { resolveDeferredPushes } from "../handles/deferred-resolution.js";
import {
  mergeLateHandleData,
  mergeLoaderReadHandleData,
  type LoaderReadPushes,
} from "../handles/pushed-by.js";
import { filterSegmentOrder } from "./react/filter-segment-order.js";

/**
 * The handle values a fetched loader read pushed (`_rsc_loader`: `load()`, a
 * `refreshGroup` refresh), by handle $$id, as the reply carries them
 * (rsc/loader-fetch.ts). A pending push is its promise.
 */
export type FetchedLoaderHandles = Record<string, unknown[]>;

/**
 * Which loader's run pushed each of the reply's values, index-aligned per
 * handle (null: the read loader's own body), as the reply carries it.
 */
export type FetchedLoaderPushedBy = Record<string, (string | null)[]>;

/** The router state a read's data and handle values are applied to. */
export interface FetchedLoaderPage {
  eventController: EventController;
  store: NavigationStore;
}

/**
 * The loader store bucket a page read commits its data to, and the request
 * id it reserved there (use-loader.tsx).
 */
export interface FetchedLoaderBucket {
  bucketKey: string;
  requestId: number;
}

/**
 * Called with a read's reply once its data went to the loader store
 * (`LoaderStore.finishData`, or the reader's own state for a local read).
 */
export type FetchedLoaderLanding = (
  result: unknown,
  handles: FetchedLoaderHandles | undefined,
  pushedBy?: FetchedLoaderPushedBy,
) => void;

const warnedUnregistered = new Set<string>();
const warnedOutside = new Set<string>();

const pushesSomething = (
  handles: Record<string, unknown[]> | undefined,
): handles is Record<string, unknown[]> =>
  handles !== undefined &&
  Object.values(handles).some((values) => values.length > 0);

function warnUnregistered(loaderId: string, pushes: LoaderReadPushes): void {
  if (
    process.env.NODE_ENV === "production" ||
    !pushesSomething(pushes.values) ||
    warnedUnregistered.has(loaderId)
  ) {
    return;
  }
  warnedUnregistered.add(loaderId);
  console.warn(
    `[rango] Loader "${loaderId}" pushed handle values on a fetched read ` +
      `(load(), useRefreshLoaders()), but no segment on this page ` +
      `registers it with loader(), so they have no segment to belong to ` +
      `and are not applied. Register the loader on the route or layout ` +
      `whose handle values it writes, or push them from the component ` +
      `that renders the data with usePushHandle.`,
  );
}

/**
 * A local read's pushes are dropped. Development warns once per loader: as
 * for an unregistered loader when no segment of the page on screen registers
 * it, else that the read came from outside the page's route tree.
 */
function warnOutside(
  store: NavigationStore,
  loaderId: string,
  handles: FetchedLoaderHandles | undefined,
): void {
  if (process.env.NODE_ENV === "production" || !pushesSomething(handles)) {
    return;
  }
  const registered = store
    .getCachedSegments(store.getHistoryKey())
    ?.segments.some((s) => s.type === "loader" && s.loaderId === loaderId);
  if (!registered) {
    warnUnregistered(loaderId, { values: handles, pushedBy: {} });
    return;
  }
  if (warnedOutside.has(loaderId)) return;
  warnedOutside.add(loaderId);
  console.warn(
    `[rango] Loader "${loaderId}" pushed handle values on a load() from a ` +
      `component outside the page's route tree (no route context). That ` +
      `read's data stays with the component, so its values have no segment ` +
      `of the page to belong to and are not applied. To change the page's ` +
      `title or crumbs, refresh the page's own data with load() from a ` +
      `component inside the route, or call useRouter().refresh().`,
  );
}

/**
 * The entry of every key of a page (`keys`) gets `data` written by `write`
 * from its own copy.
 */
function writePageEntries(
  store: NavigationStore,
  keys: readonly string[],
  write: (cached: HandleData, matched: string[]) => HandleData | undefined,
): void {
  for (const key of keys) {
    const cached = store.getCachedSegments(key);
    if (!cached) continue;
    const next = write(
      cached.handleData ?? {},
      cached.segments.map((s) => s.id),
    );
    if (next) store.updateCacheHandleData(key, next);
  }
}

const onScreen = (store: NavigationStore, keys: readonly string[]): boolean =>
  keys.includes(store.getHistoryKey());

/**
 * Start a read of `loaderId`. Call it when the request is sent; the returned
 * function lands the reply.
 *
 * A page read (a plain refetch into `bucket`, which a reader with route
 * context reads: LoaderStore.hasRouteReaders) changes what the page shows as one
 * unit, its data and its handle values, and the history entry is written from
 * that unit, so Back shows the page as it was left. It lands exactly when its
 * data lands: the loader store holds its result in `bucket`
 * (LoaderStore.holdsRequest: no newer request or route-data change since)
 * and an entry of the page it was sent from (its key, a shallow navigation's
 * twin, a commit written in their place) still holds the loader data it was
 * requested for (NavigationStore.beginPageRead). Then each such entry takes
 * the read's data (every loader segment of the loader, in place), and its
 * handle values, once their pending
 * pushes settle, replace the loader's earlier ones in its segment (a rejected
 * or nullish one dropped, as on the navigation lane), on their own after the
 * data: a handle value never holds the loader's data. They apply live while
 * the entry still holds this read's result and is the page on screen, and the
 * entry's copy is written from the live data when they apply; off screen they
 * go to the entry directly, through the same merge. While the hydration
 * window is open the entry takes the data with the values, when the window
 * closes. When the loader store drops the data, nothing is written. A loader
 * no segment of the page registers has no segment to own its pushes: they are
 * not applied (warned once per loader in development).
 *
 * Any other read is local (no `bucket`: the reader keeps its data in its own
 * state; or a bucket only readers with no route context read): its data stays
 * off the page and its values are dropped, warned once per loader in
 * development. A reader outside the route tree that shares a `key` bucket with
 * a route reader refreshes the page's data, so its read is a page read.
 */
export function startFetchedLoaderRead(
  loaderId: string,
  page: FetchedLoaderPage | undefined,
  bucket: FetchedLoaderBucket | undefined,
): FetchedLoaderLanding {
  // No page (no router state to apply to): nothing to apply, nothing to gate.
  if (!page) return () => {};
  const { eventController, store } = page;
  // A read into a bucket no reader with route context reads keeps its data
  // off the page: its values have no segment to belong to.
  if (!bucket || !store.loaders.hasRouteReaders(bucket.bucketKey)) {
    return (_result, handles) => warnOutside(store, loaderId, handles);
  }
  const read = store.beginPageRead(loaderId);

  const applyHandles = async (
    result: unknown,
    handles: FetchedLoaderHandles,
    pushedBy: FetchedLoaderPushedBy | undefined,
    dataWaits: boolean,
  ): Promise<void> => {
    const pushes = await resolveDeferredPushes(handles, pushedBy);
    if (dataWaits ? !read.current() : !read.holds()) return;
    if (onScreen(store, read.historyKeys())) {
      // The entry's copy is written when the values apply: after the
      // hydration window, from the data they were applied to.
      const applied = (data: HandleData): void => {
        if (dataWaits && !read.land(result)) return;
        writePageEntries(store, read.historyKeys(), () => data);
      };
      if (!eventController.setLoaderReadHandleData(loaderId, pushes, applied)) {
        if (dataWaits) read.land(result);
        warnUnregistered(loaderId, pushes);
      }
      return;
    }
    if (dataWaits && !read.land(result)) return;
    writePageEntries(store, read.historyKeys(), (cached, matched) =>
      mergeLoaderReadHandleData(
        cached,
        filterSegmentOrder(matched),
        matched,
        loaderId,
        pushes,
      ),
    );
  };

  return (result, handles, pushedBy) => {
    if (!store.loaders.holdsRequest(bucket.bucketKey, bucket.requestId)) {
      return;
    }
    // During the hydration window the page's handle writes wait, and the
    // entry takes the data with the values, when they apply.
    const dataWaits =
      handles !== undefined &&
      eventController.getHydrationSnapshot() !== undefined &&
      onScreen(store, read.historyKeys());
    if (!dataWaits && !read.land(result)) return;
    if (!handles) return;
    applyHandles(result, handles, pushedBy, dataWaits).catch((error) =>
      console.error("[rango] Error applying a loader read's handles:", error),
    );
  };
}

/**
 * Apply a late handle yield of the document (`metadata.handlesLate`, applied
 * by rsc-router.tsx) to the page of `historyKey`, the document's entry.
 * `late` is the document render's full state so far, `matched` its segment
 * ids. A read that landed since the document is newer for its loader, so the
 * yield is merged, not swapped in (handles/pushed-by.ts mergeLateHandleData).
 * While the page is on screen the live store takes it first, waiting in the
 * hydration window like any handle write, and the entry of every key of the
 * page is written from the result; off screen, and during the window, each
 * entry takes it directly, through the same merge.
 */
export function applyLateHandles(
  page: FetchedLoaderPage,
  late: HandleData,
  matched: string[],
  historyKey: string,
): void {
  const { eventController, store } = page;
  // The keys of the document's page (a shallow navigation's twin keys
  // share its segments array).
  const pageKeys = (): string[] => store.getPageHistoryKeys(historyKey);
  const readRefreshed = (): ReadonlySet<string> =>
    store.getPageReadLoaders(historyKey);
  const writeEntries = (): void =>
    writePageEntries(store, pageKeys(), (cached) =>
      mergeLateHandleData(cached, late, matched, readRefreshed()),
    );
  if (!onScreen(store, pageKeys())) {
    writeEntries();
    return;
  }
  // While the hydration window is open the live write waits, but a commit
  // made meanwhile reads the page from its entry (liveHandleDataForCache: a
  // link to the page, a navigation taking a shared segment's pushes), so the
  // entry takes the push now too, through the same merge.
  if (eventController.getHydrationSnapshot()) writeEntries();
  eventController.setLateHandleData(late, matched, readRefreshed, (data) =>
    writePageEntries(store, pageKeys(), () => data),
  );
}
