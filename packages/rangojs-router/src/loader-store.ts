/**
 * LoaderStore — shared subscription model for `useLoader` / `useFetchLoader`.
 *
 * Each bucket key gets one entry that holds the latest committed snapshot plus a
 * set of listeners. Snapshots are frozen and replaced atomically on mutation, so
 * subscribers can compare snapshot identity and avoid unnecessary updates
 * between real changes.
 *
 * The bucket key is `loader.$$id` by default, or `loader.$$id + key` when the
 * hook is given an explicit client refresh `key`. Multiple buckets belonging to
 * the same loader form a family (indexed by `loader.$$id`) so a navigation /
 * route-context reset can clear them all at once via `clearFamily`.
 *
 * Mutations that come in for an old request id (e.g. a slow response that
 * resolves after a newer load() was issued, or after a navigation cleared the
 * entry) are silently dropped. `reserveRequestId` is the only way to claim the
 * "latest" slot; `clear` bumps it too so pre-navigation in-flight loads cannot
 * commit into the new route's context.
 *
 * Bucket lifecycle differs by registration:
 *   - Sticky buckets (a route-registered reader subscribed at least once) keep
 *     their entry after the last subscriber leaves so an in-flight load() can
 *     still commit on remount; they reset on navigation via `clearFamily`.
 *   - Ephemeral buckets (only ever subscribed by readers with no route context,
 *     i.e. keyed `useFetchLoader` of an unregistered loader) have no
 *     route-context reset trigger, so they are reference-counted: dropped once
 *     the last subscriber unsubscribes. The drop is deferred to a microtask and
 *     cancelled on resubscribe so a StrictMode / transition remount does not
 *     reclaim a bucket that is about to be reused, and is held until any
 *     in-flight load settles.
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

/**
 * Options for `subscribe`.
 */
export interface SubscribeOptions {
  /**
   * Family id (`loader.$$id`) this bucket belongs to. `clearFamily` uses it to
   * reach every keyed bucket of the same loader. Defaults to the bucket key.
   */
  loaderId?: string;
  /**
   * When true, this subscription is from a reader with no route context (keyed
   * `useFetchLoader` of an unregistered loader). Such buckets have no
   * route-context reset trigger and are reference-counted instead. A bucket
   * becomes sticky for the rest of its life as soon as any non-ephemeral
   * subscriber attaches, and from then on resets via `clearFamily`.
   */
  ephemeral?: boolean;
  /**
   * Cross-loader refresh group name(s). Tags this bucket so `refreshGroups(name)`
   * can refresh it alongside buckets of other loaders. A bucket may be tagged
   * with several group names at once (pass an array); it is then refreshed when
   * ANY of its groups is refreshed. Group membership follows subscriber presence:
   * a bucket leaves a group when that group's last subscriber unsubscribes.
   */
  group?: string | string[];
  /**
   * Plain-GET refresh thunk used by `refreshGroups`. Provided alongside `group`.
   * Refreshes this bucket in place (no params/body) and rejects on failure.
   */
  refetch?: () => Promise<void>;
}

interface InternalEntry {
  snapshot: LoaderEntry;
  listeners: Set<() => void>;
  /** Monotonically increasing. Bumped by reserveRequestId() and clear(). */
  latestRequestId: number;
  /** Family id (loader.$$id) this bucket belongs to. */
  loaderId: string;
  /**
   * True once any non-ephemeral subscriber has attached. Sticky buckets are
   * never reference-count-dropped; they reset via clearFamily().
   */
  sticky: boolean;
  /** A deferred refcount-drop microtask is scheduled and not yet cancelled. */
  pendingClear: boolean;
  /**
   * The last subscriber left while a load() was in flight. Drop the bucket once
   * that request settles, if it is still subscriberless.
   */
  clearWhenSettled: boolean;
  /**
   * Cross-loader refresh groups this bucket belongs to, mapped to the number of
   * current subscribers that requested each group. A bucket can be in several
   * groups at once (one read tagged with multiple names, or different subscribers
   * tagging the same shared bucket with different names); refcounting keeps
   * membership independent of subscribe/unsubscribe order.
   */
  groups: Map<string, number>;
  /** Plain-GET refresh thunk for `refreshGroups`, set while in any group. */
  refetch: (() => Promise<void>) | undefined;
}

/**
 * Normalize a group tag option (`undefined | string | string[]`) to a deduped
 * list of names. Deduping keeps a single subscriber from being counted more than
 * once in one group when the caller passes a repeated name.
 */
function normalizeGroups(group: string | string[] | undefined): string[] {
  if (group === undefined) return [];
  if (typeof group === "string") return [group];
  return [...new Set(group)];
}

export class LoaderStore {
  private readonly entries = new Map<string, InternalEntry>();
  /** loader.$$id -> set of bucket keys, so clearFamily() can reach every bucket. */
  private readonly families = new Map<string, Set<string>>();
  /** refresh group name -> set of bucket keys, for refreshGroups(). */
  private readonly groups = new Map<string, Set<string>>();

  private getOrCreate(bucketKey: string): InternalEntry {
    let e = this.entries.get(bucketKey);
    if (!e) {
      e = {
        snapshot: EMPTY_SNAPSHOT,
        listeners: new Set(),
        latestRequestId: 0,
        loaderId: bucketKey,
        sticky: false,
        pendingClear: false,
        clearWhenSettled: false,
        groups: new Map(),
        refetch: undefined,
      };
      this.entries.set(bucketKey, e);
    }
    return e;
  }

  private registerFamily(loaderId: string, bucketKey: string): void {
    let fam = this.families.get(loaderId);
    if (!fam) {
      fam = new Set();
      this.families.set(loaderId, fam);
    }
    fam.add(bucketKey);
  }

  /**
   * Subscribe to entry changes for `bucketKey`.
   * Returns an unsubscribe function. A sticky bucket's entry is kept around even
   * after the last subscriber leaves so that an in-flight `load()` can still
   * commit if the consumer remounts. An ephemeral bucket is dropped once its
   * last subscriber leaves (deferred, see maybeScheduleRefcountClear).
   */
  subscribe(
    bucketKey: string,
    cb: () => void,
    options?: SubscribeOptions,
  ): () => void {
    const e = this.getOrCreate(bucketKey);
    const loaderId = options?.loaderId ?? bucketKey;
    e.loaderId = loaderId;
    this.registerFamily(loaderId, bucketKey);
    if (options?.ephemeral !== true) e.sticky = true;
    // Normalize the group tag(s) to a deduped list so one subscriber is counted
    // once per distinct group, and subscribe/unsubscribe stay symmetric (the
    // same list drives both addToGroup and releaseGroup).
    const groups = normalizeGroups(options?.group);
    for (const group of groups) {
      this.addToGroup(group, bucketKey, e, options?.refetch);
    }
    // A fresh subscriber means the bucket is wanted again: cancel any pending
    // refcount-drop and the settle-then-drop intent.
    e.pendingClear = false;
    e.clearWhenSettled = false;
    e.listeners.add(cb);
    return () => {
      e.listeners.delete(cb);
      // Group membership is refcounted per subscriber so refreshGroups() never
      // fetches for an unmounted reader, and a bucket shared by subscribers in
      // different groups stays in each group until ALL of that group's
      // subscribers have left (order-independent).
      for (const group of groups) this.releaseGroup(group, bucketKey, e);
      this.maybeScheduleRefcountClear(bucketKey, e);
    };
  }

  private addToGroup(
    group: string,
    bucketKey: string,
    e: InternalEntry,
    refetch: (() => Promise<void>) | undefined,
  ): void {
    e.groups.set(group, (e.groups.get(group) ?? 0) + 1);
    // One thunk per bucket — every subscriber of a bucket provides an
    // equivalent plain-GET refresh, so keeping the latest is fine.
    if (refetch) e.refetch = refetch;
    let members = this.groups.get(group);
    if (!members) {
      members = new Set();
      this.groups.set(group, members);
    }
    members.add(bucketKey);
  }

  private releaseGroup(
    group: string,
    bucketKey: string,
    e: InternalEntry,
  ): void {
    const next = (e.groups.get(group) ?? 0) - 1;
    if (next > 0) {
      e.groups.set(group, next);
      return;
    }
    e.groups.delete(group);
    const members = this.groups.get(group);
    if (members) {
      members.delete(bucketKey);
      if (members.size === 0) this.groups.delete(group);
    }
  }

  /** Remove a bucket from every group it belongs to (used when it is dropped). */
  private removeFromAllGroups(bucketKey: string, e: InternalEntry): void {
    for (const group of e.groups.keys()) {
      const members = this.groups.get(group);
      if (members) {
        members.delete(bucketKey);
        if (members.size === 0) this.groups.delete(group);
      }
    }
    e.groups.clear();
  }

  /**
   * Refresh every currently-mounted bucket tagged with ANY of the given group
   * names, with a plain GET (no params/body). Accepts a single name or an array
   * of names. A bucket that belongs to more than one of the named groups is
   * refreshed exactly once (members are unioned and deduped by bucket key), as
   * are multiple reads of one bucket. Resolves when all refreshes settle; rejects
   * with an `AggregateError` of the failures if any member fails — each failing
   * member also records its error on its own snapshot.
   */
  async refreshGroups(groups: string | string[]): Promise<void> {
    const names = typeof groups === "string" ? [groups] : groups;
    // Union the member buckets across every named group, deduped by key, so a
    // bucket tagged into two of the requested groups is fetched a single time.
    const buckets = new Set<string>();
    for (const name of names) {
      const members = this.groups.get(name);
      if (!members) continue;
      for (const bucketKey of members) buckets.add(bucketKey);
    }
    if (buckets.size === 0) return;
    const thunks: Array<() => Promise<void>> = [];
    for (const bucketKey of buckets) {
      const e = this.entries.get(bucketKey);
      if (!e || e.listeners.size === 0 || !e.refetch) continue;
      thunks.push(e.refetch);
    }
    if (thunks.length === 0) return;
    const results = await Promise.allSettled(thunks.map((t) => t()));
    const reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason);
    if (reasons.length > 0) {
      const label = names.map((n) => `"${n}"`).join(", ");
      throw new AggregateError(
        reasons,
        `refreshGroups(${label}) had ${reasons.length} failure(s)`,
      );
    }
  }

  /**
   * Schedule a deferred drop for an ad-hoc (never-sticky) bucket whose last
   * subscriber just left. Deferred to a microtask so a StrictMode / transition
   * remount that resubscribes in the same tick cancels it.
   */
  private maybeScheduleRefcountClear(
    bucketKey: string,
    e: InternalEntry,
  ): void {
    if (e.listeners.size > 0) return;
    // Sticky buckets persist for remount; they reset via clearFamily().
    if (e.sticky) return;
    if (e.pendingClear) return;
    e.pendingClear = true;
    queueMicrotask(() => {
      if (!e.pendingClear) return; // cancelled by a resubscribe
      e.pendingClear = false;
      if (e.listeners.size > 0) return; // resubscribed before the microtask ran
      if (e.snapshot.isLoading) {
        // Don't drop mid-flight; let the request commit, then drop.
        e.clearWhenSettled = true;
        return;
      }
      this.dropBucket(bucketKey);
    });
  }

  /** Remove a bucket entry entirely and prune it from its family/group indexes. */
  private dropBucket(bucketKey: string): void {
    const e = this.entries.get(bucketKey);
    if (!e) return;
    this.removeFromAllGroups(bucketKey, e);
    this.entries.delete(bucketKey);
    const fam = this.families.get(e.loaderId);
    if (fam) {
      fam.delete(bucketKey);
      if (fam.size === 0) this.families.delete(e.loaderId);
    }
  }

  /** Drop an ephemeral bucket that settled with no subscribers left. */
  private dropIfSettled(bucketKey: string, e: InternalEntry): void {
    if (e.clearWhenSettled && e.listeners.size === 0) {
      e.clearWhenSettled = false;
      this.dropBucket(bucketKey);
    }
  }

  /**
   * Returns the current snapshot for `bucketKey`. Stable reference between
   * mutations — subscribers rely on this to avoid spurious re-renders.
   * Returns `EMPTY_SNAPSHOT` (a singleton) when the entry has never been
   * mutated or has been cleared.
   */
  getSnapshot(bucketKey: string): LoaderEntry {
    return this.entries.get(bucketKey)?.snapshot ?? EMPTY_SNAPSHOT;
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
  reserveRequestId(bucketKey: string): number {
    const e = this.getOrCreate(bucketKey);
    e.latestRequestId++;
    return e.latestRequestId;
  }

  /**
   * Mark the request as in-flight: `isLoading = true`, `error = null`.
   * Combines the two operations so a retry doesn't render the previous
   * error during the new request. Gated on `requestId === latestRequestId`
   * for symmetry with the other mutators.
   */
  beginRequest(bucketKey: string, requestId: number): void {
    const e = this.entries.get(bucketKey);
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
  finishData<T>(bucketKey: string, requestId: number, value: T): void {
    const e = this.entries.get(bucketKey);
    if (!e || requestId !== e.latestRequestId) return;
    e.snapshot = Object.freeze({
      value,
      error: null,
      isLoading: false,
      requestId,
    });
    this.notify(e);
    this.dropIfSettled(bucketKey, e);
  }

  /**
   * Commit an error. Preserves the last good `value` so consumers can keep
   * showing previous data while displaying the error if they choose. No-op
   * if `requestId` is not the latest.
   */
  finishError(bucketKey: string, requestId: number, error: Error): void {
    const e = this.entries.get(bucketKey);
    if (!e || requestId !== e.latestRequestId) return;
    e.snapshot = Object.freeze({
      value: e.snapshot.value,
      error,
      isLoading: false,
      requestId,
    });
    this.notify(e);
    this.dropIfSettled(bucketKey, e);
  }

  /**
   * Update loading flag. Gated on `requestId` to fix the race where an old
   * load() finishes after a new one started — its `setLoading(false)` would
   * otherwise hide the new request's spinner.
   */
  setLoading(bucketKey: string, requestId: number, isLoading: boolean): void {
    const e = this.entries.get(bucketKey);
    if (!e || requestId !== e.latestRequestId) return;
    if (e.snapshot.isLoading === isLoading) return;
    e.snapshot = Object.freeze({
      ...e.snapshot,
      isLoading,
    });
    this.notify(e);
  }

  /**
   * Reset a single bucket entry. Bumps `latestRequestId` so any in-flight
   * `load()` whose promise is still pending will fail its gate when it resolves
   * and be dropped — prevents pre-navigation loads from clobbering the new
   * route's context. The entry itself is kept (sticky-bucket semantics).
   */
  clear(bucketKey: string): void {
    const e = this.entries.get(bucketKey);
    if (!e) return;
    e.latestRequestId++;
    if (e.snapshot === EMPTY_SNAPSHOT) return;
    e.snapshot = EMPTY_SNAPSHOT;
    this.notify(e);
  }

  /**
   * Reset every sticky bucket belonging to `loaderId`. Called on navigation /
   * route-context change: all route-registered reads of the loader (keyed or
   * not) drop back to seeding from fresh `loaderData`. Ephemeral buckets are
   * intentionally left alone — they are governed by subscriber refcount, so a
   * persistent keyed reader outside the outlet keeps its value across a
   * navigation rather than blanking out.
   */
  clearFamily(loaderId: string): void {
    const fam = this.families.get(loaderId);
    if (!fam) return;
    for (const bucketKey of fam) {
      const e = this.entries.get(bucketKey);
      if (!e || !e.sticky) continue;
      this.clear(bucketKey);
    }
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
    this.families.clear();
    this.groups.clear();
  }
}

/**
 * Module-level singleton. Each browser tab gets its own; SSR never mutates it.
 * The hook falls through to `OutletContext.loaderData` during the server render.
 */
export const loaderStore: LoaderStore = new LoaderStore();

export const EMPTY_LOADER_SNAPSHOT: LoaderEntry = EMPTY_SNAPSHOT;
