/**
 * LoaderStore — shared subscription model for `useLoader` / `useFetchLoader`.
 *
 * Each loader id (loader.$$id) gets one entry that holds the latest committed
 * snapshot plus a set of listeners. Snapshots are frozen and replaced atomically
 * on mutation, so subscribers can compare snapshot identity and avoid
 * unnecessary updates between real changes.
 *
 * Mutations that come in for an old request id (e.g. a slow response that
 * resolves after a newer load() was issued, or after a navigation cleared the
 * entry) are silently dropped. `reserveRequestId` is the only way to claim the
 * "latest" slot; `clear` bumps it too so pre-navigation in-flight loads cannot
 * commit into the new route's context.
 *
 * The store is intentionally module-level: each browser tab is its own JS
 * realm, so there is no cross-request pollution. Server renders never mutate
 * the store — the hook falls back to `OutletContext.loaderData`.
 */

export interface LoaderEntry<T = unknown> {
  readonly value: T | undefined;
  readonly error: Error | null;
  readonly isLoading: boolean;
  /** Identifies the request that produced this snapshot. 0 means "no request". */
  readonly requestId: number;
}

const EMPTY_SNAPSHOT: LoaderEntry = Object.freeze({
  value: undefined,
  error: null,
  isLoading: false,
  requestId: 0,
});

interface InternalEntry {
  snapshot: LoaderEntry;
  listeners: Set<() => void>;
  /** Monotonically increasing. Bumped by reserveRequestId() and clear(). */
  latestRequestId: number;
}

export class LoaderStore {
  private readonly entries = new Map<string, InternalEntry>();

  private getOrCreate(id: string): InternalEntry {
    let e = this.entries.get(id);
    if (!e) {
      e = {
        snapshot: EMPTY_SNAPSHOT,
        listeners: new Set(),
        latestRequestId: 0,
      };
      this.entries.set(id, e);
    }
    return e;
  }

  /**
   * Subscribe to entry changes for `id`.
   * Returns an unsubscribe function. The store keeps the entry around even
   * after the last subscriber leaves so that an in-flight `load()` can still
   * commit if the consumer remounts.
   */
  subscribe(id: string, cb: () => void): () => void {
    const e = this.getOrCreate(id);
    e.listeners.add(cb);
    return () => {
      e.listeners.delete(cb);
    };
  }

  /**
   * Returns the current snapshot for `id`. Stable reference between mutations
   * — subscribers rely on this to avoid spurious re-renders.
   * Returns `EMPTY_SNAPSHOT` (a singleton) when the entry has never been
   * mutated or has been cleared.
   */
  getSnapshot(id: string): LoaderEntry {
    return this.entries.get(id)?.snapshot ?? EMPTY_SNAPSHOT;
  }

  /**
   * Reserve a fresh request id for an upcoming `load()` call. The returned id
   * is the new "latest"; any older in-flight requests will fail their gating
   * check on `finishData` / `finishError` / `finishLoading` and be dropped.
   *
   * Callers should follow with `beginRequest(id, requestId)` to flip the
   * loading flag on AND clear any leftover error from a previous attempt
   * — the latter matters for `throwOnError: false` consumers, which would
   * otherwise keep showing the stale error throughout the retry.
   */
  reserveRequestId(id: string): number {
    const e = this.getOrCreate(id);
    e.latestRequestId++;
    return e.latestRequestId;
  }

  /**
   * Mark the request as in-flight: `isLoading = true`, `error = null`.
   * Combines the two operations so a retry doesn't render the previous
   * error during the new request. Gated on `requestId === latestRequestId`
   * for symmetry with the other mutators.
   */
  beginRequest(id: string, requestId: number): void {
    const e = this.entries.get(id);
    if (!e || requestId !== e.latestRequestId) return;
    if (e.snapshot.isLoading && e.snapshot.error === null) return;
    e.snapshot = Object.freeze({
      value: e.snapshot.value,
      error: null,
      isLoading: true,
      requestId,
    });
    this.notify(e);
  }

  /**
   * Commit a successful result. No-op if `requestId` is not the latest
   * (a newer `load()` was issued or `clear()` ran). Clearing `error` is
   * intentional: a successful refetch should hide the previous failure.
   */
  finishData<T>(id: string, requestId: number, value: T): void {
    const e = this.entries.get(id);
    if (!e || requestId !== e.latestRequestId) return;
    e.snapshot = Object.freeze({
      value,
      error: null,
      isLoading: false,
      requestId,
    });
    this.notify(e);
  }

  /**
   * Commit an error. Preserves the last good `value` so consumers can keep
   * showing previous data while displaying the error if they choose. No-op
   * if `requestId` is not the latest.
   */
  finishError(id: string, requestId: number, error: Error): void {
    const e = this.entries.get(id);
    if (!e || requestId !== e.latestRequestId) return;
    e.snapshot = Object.freeze({
      value: e.snapshot.value,
      error,
      isLoading: false,
      requestId,
    });
    this.notify(e);
  }

  /**
   * Update loading flag. Gated on `requestId` to fix the race where an old
   * load() finishes after a new one started — its `setLoading(false)` would
   * otherwise hide the new request's spinner.
   */
  setLoading(id: string, requestId: number, isLoading: boolean): void {
    const e = this.entries.get(id);
    if (!e || requestId !== e.latestRequestId) return;
    if (e.snapshot.isLoading === isLoading) return;
    e.snapshot = Object.freeze({
      ...e.snapshot,
      isLoading,
    });
    this.notify(e);
  }

  /**
   * Reset the entry. Bumps `latestRequestId` so any in-flight `load()` whose
   * promise is still pending will fail its gate when it resolves and be
   * dropped — prevents pre-navigation loads from clobbering the new route's
   * context.
   */
  clear(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.latestRequestId++;
    if (e.snapshot === EMPTY_SNAPSHOT) return;
    e.snapshot = EMPTY_SNAPSHOT;
    this.notify(e);
  }

  private notify(e: InternalEntry): void {
    for (const cb of e.listeners) cb();
  }

  /**
   * Test-only escape hatch. Drops every entry. Production code should never
   * call this; the store is process-scoped and lives for the tab's lifetime.
   * @internal
   */
  reset(): void {
    this.entries.clear();
  }
}

/**
 * Module-level singleton. Each browser tab gets its own; SSR never mutates it.
 * The hook falls through to `OutletContext.loaderData` during the server render.
 */
export const loaderStore: LoaderStore = new LoaderStore();

export const EMPTY_LOADER_SNAPSHOT: LoaderEntry = EMPTY_SNAPSHOT;
