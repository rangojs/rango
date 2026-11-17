import type { EventController } from "./event-controller.js";
import type { NavigationStore } from "./types.js";
import { resolveDeferredPushes } from "../handles/deferred-resolution.js";

/**
 * The handle values a fetched loader read pushed (`_rsc_loader`: `load()`, a
 * `refreshGroup` refresh), by handle $$id, as the reply carries them
 * (rsc/loader-fetch.ts). A pending push is its promise.
 */
export type FetchedLoaderHandles = Record<string, unknown[]>;

/** The router state a read's handle values are applied to. */
export interface FetchedLoaderPage {
  eventController: EventController;
  store: NavigationStore;
}

/** The newest read sent for each loader: an older reply leaves the handles. */
const latestRead = new Map<string, number>();
let readSeq = 0;
const warnedUnregistered = new Set<string>();

/**
 * Start a read of `loaderId` from the page on screen. Call it when the request
 * is sent; the returned function applies the reply's handle values.
 *
 * The values replace the loader's earlier ones in its segment once the
 * pending ones settle (a rejected or nullish one dropped, as on the
 * navigation lane), on their own after the data: a handle value never holds
 * the loader's data. They apply only while the page the read was sent from is
 * still on screen (same history entry, no commit since, as NavigationProvider's
 * handle stream checks) and no newer read of the loader was sent, and the
 * history entry keeps them for Back. A loader no segment of the page
 * registers has no segment to own its pushes: they are not applied (warned
 * once per loader in development).
 */
export function startFetchedLoaderRead(
  loaderId: string,
  page: FetchedLoaderPage | undefined,
): (handles: FetchedLoaderHandles | undefined) => void {
  const seq = ++readSeq;
  latestRead.set(loaderId, seq);
  const historyKey = page?.store.getHistoryKey();
  const navInstance = page?.store.getNavInstance();
  const current = (): boolean =>
    page !== undefined &&
    latestRead.get(loaderId) === seq &&
    page.store.getHistoryKey() === historyKey &&
    page.store.getNavInstance() === navInstance;

  const apply = async (
    handles: FetchedLoaderHandles | undefined,
  ): Promise<void> => {
    if (!handles || !current()) return;
    const values = await resolveDeferredPushes(handles);
    if (!current()) return;
    const { eventController, store } = page!;
    if (!eventController.setLoaderReadHandleData(loaderId, values)) {
      if (
        process.env.NODE_ENV !== "production" &&
        Object.values(values).some((pushed) => pushed.length > 0) &&
        !warnedUnregistered.has(loaderId)
      ) {
        warnedUnregistered.add(loaderId);
        console.warn(
          `[rango] Loader "${loaderId}" pushed handle values on a fetched read ` +
            `(load(), useRefreshLoaders()), but no segment on this page ` +
            `registers it with loader(), so they have no segment to belong to ` +
            `and are not applied. Register the loader on the route or layout ` +
            `whose handle values it writes.`,
        );
      }
      return;
    }
    store.updateCacheHandleDataIfOwned(
      historyKey!,
      eventController.getHandleState().data,
      navInstance!,
    );
  };
  return (handles) => {
    apply(handles).catch((error) =>
      console.error("[rango] Error applying a loader read's handles:", error),
    );
  };
}
