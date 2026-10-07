import type {
  NavigationStore,
  NavigationClient,
  UpdateSubscriber,
  ResolvedSegment,
} from "./types.js";
import type { ReactNode } from "react";
import * as React from "react";
import { startTransition } from "react";

// addTransitionType is only available in React experimental
const addTransitionType: ((type: string) => void) | undefined =
  "addTransitionType" in React ? (React as any).addTransitionType : undefined;

import type { RenderSegmentsOptions } from "../segment-system.js";
import { reconcileSegments } from "./segment-reconciler.js";
import type { ReconcileActor } from "./segment-reconciler.js";
import {
  clearPendingFill,
  emitAdoption,
  setPendingFill,
} from "./pending-fill.js";
import {
  emitNavigationError,
  toNetworkError,
} from "./network-error-handler.js";
import {
  hasActiveIntercept as hasActiveInterceptSlots,
  isInterceptSegment,
} from "./intercept-utils.js";
import type { BoundTransaction } from "./navigation-transaction.js";
import { ServerRedirect } from "../errors.js";
import {
  debugLog,
  isBrowserDebugEnabled,
  IS_BROWSER_DEBUG,
} from "./logging.js";
import {
  validateRedirectOrigin,
  validateExternalRedirect,
} from "./validate-redirect-origin.js";
import type { NavigationUpdate } from "./types.js";
import { OPTIMISTIC_COMMIT_TRANSITION_TYPE } from "./optimistic-commit.js";
import { loaderStore } from "../loader-store.js";
import {
  collectClientRevalidationDecisions,
  setActiveInterceptTargets,
} from "../client-urls/navigation.js";
import {
  decideCommitGatedOff,
  mergeSegmentParams,
  type TransitionWhenActionInput,
} from "./transition-when.js";
import { buildHistoryState } from "./history-state.js";
import { addLocationState } from "./react/location-state-shared.js";
import type { TransitionWhenKind } from "../types/segments.js";

/**
 * Hold/animate decision for a commit: a non-intercept segment carries a
 * transition, no intercept is presented, and this navigation's
 * transition({ when }) decision did not gate it off.
 */
export function shouldStartViewTransition(
  segments: readonly ResolvedSegment[],
  transitionGatedOff: boolean = false,
): boolean {
  if (transitionGatedOff) return false;
  let hasIntercept = false;
  let hasTransition = false;
  for (const s of segments) {
    if (isInterceptSegment(s)) hasIntercept = true;
    else if (s.transition) hasTransition = true;
  }
  return !hasIntercept && hasTransition;
}

/**
 * Transition commit. Every held commit announces the loader streams the
 * committed tree is still receiving (loader-store.ts announcePendingStreams)
 * so held useLoader readers pin isLoading:true until this transition lands;
 * settled/cached segments make it a no-op. Urgent commits call onUpdate
 * directly: nothing is held there, a reader of a pending stream suspends to
 * its fallback. Also used by renderRoute's navigate() (testing/render-route.tsx).
 */
export function commitInTransition(
  onUpdate: UpdateSubscriber,
  segments: readonly ResolvedSegment[],
  update: NavigationUpdate,
  transitionTypes: readonly string[],
): void {
  startTransition(() => {
    loaderStore.announcePendingStreams(segments);
    if (addTransitionType) {
      for (const type of transitionTypes) addTransitionType(type);
    }
    onUpdate(update);
  });
}

/**
 * Configuration for creating a partial updater
 */
export interface PartialUpdateConfig {
  store: NavigationStore;
  client: NavigationClient;
  onUpdate: UpdateSubscriber;
  renderSegments: (
    segments: ResolvedSegment[],
    options?: RenderSegmentsOptions,
  ) => Promise<ReactNode> | ReactNode;
  /** RSC version getter — returns the current version (may change after HMR) */
  getVersion?: () => string | undefined;
  /**
   * A fill (`prefetch: false`) is not a navigation: it has no transaction to
   * carry a redirect, or the location state the server set, to their owner.
   * The bridge that owns navigation supplies both. Without them a redirect
   * is a document navigation and the state is dropped.
   */
  fill?: {
    redirect(url: string, state?: Record<string, unknown>): void;
    locationState(state: Record<string, unknown>): void;
  };
}

const FILL_REDIRECT_NOT_FOLLOWED = "[rango] fill: redirect not followed";

/**
 * How long React keeps a fallback on screen before a Suspense retry may
 * replace it (FALLBACK_THROTTLE_MS in react-reconciler's work loop). A plain
 * click's fallback shows with the first chunk of its response, so that click
 * reveals nothing sooner than this after the chunk. An adopted click's
 * fallback shows with the click, a round trip earlier: left to React, its
 * reveal comes that much sooner, before data the plain click's reveal
 * includes, with a second fallback where the plain click shows one (measured
 * with 100 ms to the first chunk: content 200 ms late). So a fill that is
 * still streaming lands this long after its own first chunk.
 *
 * Not ours to tune. The latency cases of
 * expectAdoptedClickIsNeverWorseThanAPlainClick (tests/shared-e2e) fail when
 * React's value moves either way.
 */
const FALLBACK_THROTTLE_MS = 300;

/**
 * A promise the browser created for a deferred segment's missing value. The
 * segment is always new to the page: a payload that defers is adopted only
 * on the page it was prefetched from, with the segments it was prefetched
 * with (rsc/rsc-rendering.ts sourceScoped, prefetch/cache.ts buildSourceKey),
 * and the server defers nothing that request listed as held.
 */
interface Gate {
  promise: Promise<unknown>;
  resolve(value: unknown): void;
}

/**
 * One adoption of a payload that carries deferred segments (`prefetch:
 * false`), from the moment its gates are armed to the moment its fill lands
 * or is abandoned. See docs/design/prefetch-false.md, "The browser".
 */
interface Fill {
  /** Placeholder segment (the payload's object) -> its gate. */
  gates: Map<ResolvedSegment, Gate>;
  /** The placeholders that are units: every one that is not a loader. */
  units: ResolvedSegment[];
  /** The adopted payload's `matched`, which its handle stream still reads. */
  matched: string[];
  controller: AbortController;
  /** The response arrived: from here it is dropped, never aborted mid-read. */
  responded: boolean;
  cancelled: boolean;
  /** tx.commit() ran for the adoption: its placeholders are on screen. */
  committed: boolean;
  /** Resolves once React has committed the adoption's tree. */
  shown: Promise<void>;
  show(): void;
  /** The tree on screen: the adoption's, or the one a waiting fill landed. */
  root?: ReactNode;
  /** Whether the adoption rendered its tree with forceAwait. */
  forceAwait?: boolean;
  /**
   * Set where the adoption commits nothing until its fill has responded: a
   * deferred unit on a page a plain click commits in a transition. React
   * renders such a page's content in the commit that shows its fallback, in
   * a render that can wait. Once the fallback is up no commit can bring the
   * content in that way: each either starts a view transition of its own
   * (whenever a <ViewTransition> is mounted anywhere on the page, the
   * router's included) or schedules a retry that commits while a read is
   * still streaming, which starts one too, and the reveal waits behind it
   * (measured: three transitions for two, content up to 280 ms late). So the
   * adoption's update carries a promise of the tree, resolved here.
   */
  land?: (root: ReactNode) => void;
  /** Settles with `committed`, or false when the adoption is abandoned. */
  whenCommitted: Promise<boolean>;
  commit(): void;
  cancel(): void;
}

/** What one fetchPartialUpdate call adopted, if its payload deferred. */
interface Adoption {
  fill?: Fill;
  /** Resolves once the fill has landed and streamed, or was abandoned. */
  filled?: Promise<void>;
}

/**
 * Options that can override the pre-configured commit settings
 */
export interface CommitOverrides {
  /** Override scroll behavior (e.g., disable for intercepts) */
  scroll?: boolean;
  /** Override replace behavior (e.g., force replace for intercepts) */
  replace?: boolean;
  /** Mark this as an intercept route */
  intercept?: boolean;
  /** Source URL where intercept was triggered from */
  interceptSourceUrl?: string;
  /** Server-set location state to merge into history.pushState */
  serverState?: Record<string, unknown>;
  /** The committed route's name (payload metadata), remembered per history entry. */
  routeName?: string;
}

/**
 * Discriminated update mode for partial updates.
 */
export type UpdateMode =
  | {
      type: "navigate";
      /** Cached segments for the target URL. When provided, these are used to build
       * the segment map instead of the current page's segments. This ensures consistency
       * when we send cached segment IDs to the server - if the server returns empty diff,
       * we use the same segments we told the server we have. */
      targetCacheSegments?: ResolvedSegment[];
      /** Cached handle data for the target URL. When server returns empty diff and we're
       * rendering from cache, this is passed to the UI to restore breadcrumbs etc. */
      targetCacheHandleData?: Record<string, Record<string, unknown[]>>;
      /** Source URL for intercept restore (popstate cache miss) */
      interceptSourceUrl?: string;
      /**
       * The bridge already presented an optimistic clientUrls() destination
       * for this navigation: transition-lane commits add
       * OPTIMISTIC_COMMIT_TRANSITION_TYPE so router <ViewTransition>
       * boundaries do not animate the identical repaint.
       */
      optimisticPresented?: boolean;
      /**
       * A router.refresh() (or cross-tab refresh) of the current URL:
       * transition({ when }) sees kind "revalidate", not "replace".
       */
      refresh?: boolean;
    }
  | { type: "leave-intercept"; interceptSourceUrl?: string }
  | { type: "stale-revalidation"; interceptSourceUrl?: string }
  | {
      type: "action";
      interceptSourceUrl?: string;
      actionId?: string;
      /** The action's FormData and result, for transition({ when }) `action`. */
      action?: TransitionWhenActionInput;
    };

/**
 * Type for the fetchPartialUpdate function
 */
export type PartialUpdater = (
  targetUrl: string,
  segmentIds: string[] | undefined,
  isRetry: boolean,
  signal: AbortSignal | undefined,
  tx: BoundTransaction,
  mode?: UpdateMode,
) => Promise<void>;

export function createPartialUpdater(
  config: PartialUpdateConfig,
): PartialUpdater {
  const {
    store,
    client,
    onUpdate,
    renderSegments,
    getVersion = () => undefined,
  } = config;

  /**
   * The segments the page on screen holds. A placeholder (`prefetch: false`,
   * waiting for its fill) is not a copy of its segment: it never stands in
   * for one in a reconcile, and its id is never sent as held (tx.commit below
   * leaves it out of the store's ids).
   */
  function getCurrentCachedSegments(): ResolvedSegment[] {
    const currentKey = store.getHistoryKey();
    const segments = store.getCachedSegments(currentKey)?.segments || [];
    return segments.some((s) => s.deferred)
      ? segments.filter((s) => !s.deferred)
      : segments;
  }

  /**
   * Arm a gate on every deferred segment of an adopted payload: a deferred
   * loader's gate is its `loaderData`, a deferred unit's is its `component`.
   * To the rest of the client a gate is a stream that has not arrived yet.
   */
  function armGates(placeholders: ResolvedSegment[], matched: string[]): Fill {
    const gates = new Map<ResolvedSegment, Gate>();
    const units: ResolvedSegment[] = [];
    for (const segment of placeholders) {
      let resolve!: Gate["resolve"];
      const promise = new Promise<unknown>((res) => {
        resolve = res;
      });
      if (segment.type === "loader") {
        segment.loaderData = promise;
      } else {
        segment.component = promise as ReactNode;
        units.push(segment);
      }
      gates.set(segment, { promise, resolve });
    }
    let settleCommitted!: (committed: boolean) => void;
    let show!: () => void;
    const shown = new Promise<void>((res) => {
      show = res;
    });
    const fill: Fill = {
      gates,
      units,
      matched,
      controller: new AbortController(),
      responded: false,
      cancelled: false,
      committed: false,
      shown,
      show,
      whenCommitted: new Promise<boolean>((res) => {
        settleCommitted = res;
      }),
      commit() {
        fill.committed = true;
        settleCommitted(true);
        setPendingFill(fill.cancel);
      },
      cancel() {
        if (fill.cancelled) return;
        fill.cancelled = true;
        settleCommitted(false);
        // Aborting a Flight stream mid-read makes the decoder throw
        // asynchronously: abort only while waiting for the response.
        if (!fill.responded) fill.controller.abort();
      },
    };
    return fill;
  }

  /** A gate that will not be resolved must not stay a pending stream. */
  function releaseGate(placeholder: ResolvedSegment, gate: Gate): void {
    if (placeholder.type === "loader") {
      loaderStore.releasePendingStream(placeholder.loaderId!, gate.promise);
    }
  }

  /**
   * The entry on screen, while it still holds this adoption's placeholders.
   * By object, not by history key: a shallow navigation that copied the entry
   * to a new key is still the page the fill is for, and an action refetch
   * that already rendered the missing segments is not.
   */
  function entryToFill(fill: Fill): ResolvedSegment[] | undefined {
    const live = entryOnScreen();
    return live?.some((s) => fill.gates.has(s)) ? live : undefined;
  }

  function entryOnScreen(): ResolvedSegment[] | undefined {
    return store.getCachedSegments(store.getHistoryKey())?.segments;
  }

  /** A payload redirect's target, or null when the client refuses it. */
  function redirectTarget(redirect: {
    url: string;
    external?: boolean;
  }): string | null {
    return redirect.external
      ? validateExternalRedirect(redirect.url, window.location.origin)
      : validateRedirectOrigin(redirect.url, window.location.origin);
  }

  /**
   * Follow a redirect a fill was answered with: a replace navigation through
   * the bridge, a document navigation for an external target or with no
   * bridge. False when the client refuses the target.
   */
  function followFillRedirect(
    redirect: { url: string; external?: boolean },
    state: Record<string, unknown> | undefined,
  ): boolean {
    const target = redirectTarget(redirect);
    if (!target) return false;
    if (redirect.external || !config.fill) window.location.assign(target);
    else config.fill.redirect(target, state);
    return true;
  }

  /**
   * The fill request of one adoption: fetch what the prefetch deferred, merge
   * it into the entry on screen and resolve the gates. `gatedOff` is the
   * adoption's transition({ when }) decision, which the fill reuses.
   * Resolves once the fill has landed and streamed, or was abandoned. Never
   * rejects.
   */
  function runFill(
    fill: Fill,
    url: string,
    heldIds: string[],
    gatedOff: boolean,
  ): Promise<void> {
    // The stream is awaited out here: landFill's frame holds the payload,
    // the reconciled segments and the tree, and is gone once it returns.
    const landed: { streamComplete?: Promise<void> } = {};
    return landFill(fill, url, heldIds, gatedOff, landed).then(() =>
      landed.streamComplete?.catch(() => {}),
    );
  }

  async function landFill(
    fill: Fill,
    url: string,
    heldIds: string[],
    gatedOff: boolean,
    landed: { streamComplete?: Promise<void> },
  ): Promise<void> {
    try {
      const result = await client.fetchPartial({
        targetUrl: url,
        segmentIds: heldIds,
        // The page the fill completes is the page it is on.
        previousUrl: url,
        fill: true,
        signal: fill.controller.signal,
        version: getVersion(),
        routerId: store.getRouterId?.(),
      });
      fill.responded = true;
      // The fill can beat the adoption's own commit (its render awaits).
      if (!(await fill.whenCommitted)) return;

      const metadata = result.payload.metadata;
      if (metadata?.redirect) {
        if (!followFillRedirect(metadata.redirect, metadata.locationState)) {
          throw new Error(FILL_REDIRECT_NOT_FOLLOWED);
        }
        return;
      }
      if (!metadata?.isPartial) {
        throw new Error("[rango] fill: not a partial payload");
      }

      const live = entryToFill(fill);
      if (!live) return;

      const matched = metadata.matched || [];
      // The adoption's handle stream (NavigationProvider processHandles)
      // reads its payload's `matched` on every yield and drops the buckets of
      // segments outside it. A deferred unit's `matched` stops at the unit:
      // a late yield would delete what the fill pushed below it.
      fill.matched.splice(0, fill.matched.length, ...matched);
      if (metadata.locationState) {
        config.fill?.locationState(metadata.locationState);
      }

      // By the entry, not by its placeholders: what the fill pushed is
      // handed over after it has landed where React holds the adoption.
      const gone = (): boolean => fill.cancelled || entryOnScreen() !== live;
      // What the deferred handlers pushed, under the tree on screen. Every
      // update of a fill is urgent and made once the adoption is on screen.
      // In a transition of its own it would wait for the view transition
      // that is running and start another, whenever a <ViewTransition> is
      // mounted anywhere on the page, changed or not, and every reveal
      // behind it would wait in turn (measured on a unit under transition():
      // three transitions for two, content up to 280 ms late). Sooner, it
      // would commit the page ahead of the transition the adoption is in.
      // No `scroll`: a fill is not a navigation transaction. A decision here,
      // even "do not scroll", would replace the adoption's pending one
      // (NavigationProvider).
      void fill.shown.then(() => {
        if (!gone()) onUpdate({ root: fill.root, metadata });
      });

      if (!fill.land) {
        // A plain click's fallback shows with its response and React keeps
        // it up for FALLBACK_THROTTLE_MS. This one has been up since the
        // click: released now, what the fill brought would be revealed a
        // round trip sooner than a plain click reveals it, without what is
        // still on its way.
        await Promise.race([
          result.streamComplete.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, FALLBACK_THROTTLE_MS)),
        ]);
        if (gone()) return;
      }

      const kept = live.filter((s) => !s.deferred);
      const reconciled = reconcileSegments({
        actor: "stale-revalidation",
        matched,
        diff: metadata.diff || [],
        serverSegments: metadata.segments || [],
        cachedSegments: kept,
        insertMissingDiff: true,
      });
      const missing = matched.filter(
        (id) => !reconciled.segments.some((s) => s.id === id),
      );
      if (missing.length > 0) {
        throw new Error(
          `[rango] fill: missing segments [${missing.join(", ")}]`,
        );
      }

      // A unit where the adoption is on screen gets a tree, in which it
      // keeps reading its gate. The gate resolves once React has committed
      // that tree, so the unit is revealed by a Suspense retry, throttled and
      // animated as a plain click's is: with its content already there this
      // commit would reveal it at once, and a boundary inside it would show
      // its fallback for data a few milliseconds away. The gates of the
      // loaders a unit owns resolve with it: a slot reads them above its
      // content, and would otherwise show its fallback twice. Any other
      // loader's gate resolves now (React may be holding the adoption for
      // it: a read with no boundary), and its reader, which is on screen,
      // keeps reading it in the tree.
      const brought = reconciled.segments.filter(
        (s) => !kept.some((held) => held.id === s.id),
      );
      const hasUnit = fill.units.length > 0;
      const tree = !fill.land && hasUnit;
      const revealed = new Map<Gate, unknown>();
      const streams: Array<[ResolvedSegment, unknown]> = [];
      for (const [placeholder, gate] of fill.gates) {
        const next = brought.find((s) => s.id === placeholder.id);
        if (!next) {
          releaseGate(placeholder, gate);
          continue;
        }
        const unit = placeholder.type !== "loader";
        const value: unknown = unit ? next.component : next.loaderData;
        if (
          tree &&
          (unit
            ? next.loading
            : fill.units.some((u) => u.namespace === placeholder.namespace))
        ) {
          revealed.set(gate, value);
        } else {
          gate.resolve(value);
        }
        if (unit) {
          if (revealed.has(gate)) next.component = gate.promise as ReactNode;
        } else if (tree && !revealed.has(gate)) {
          streams.push([next, value]);
          next.loaderData = gate.promise;
        }
      }

      // A fill of loaders alone renders nothing: the tree on screen reads
      // the gates.
      if (hasUnit) {
        if (tree) {
          await fill.shown;
          // Rendered as the adoption's tree was, what the fill brought
          // standing in it as still streaming: nothing of it is awaited, and
          // nothing already on screen reaches React as a promise it has not
          // read, which a render that cannot wait would suspend on.
          for (const segment of brought) segment.deferred = true;
        }
        const root = await renderSegments(reconciled.mainSegments, {
          forceAwait: tree && fill.forceAwait,
          transitionGatedOff: gatedOff,
          interceptSegments:
            reconciled.interceptSegments.length > 0
              ? reconciled.interceptSegments
              : undefined,
        });
        for (const segment of brought) delete segment.deferred;
        // The entry keeps the fill's own streams: the next render from
        // this page builds on them, and a gate is a promise React has read
        // only where a reader was on screen.
        for (const [segment, stream] of streams) segment.loaderData = stream;
        if (gone()) return;
        if (fill.land) {
          // The adoption's transition is waiting for this tree: the page
          // commits once, as the plain click commits it.
          fill.land((fill.root = root));
        } else {
          // The handle stream is being read already: not handed over twice.
          onUpdate({
            root,
            metadata: { ...metadata, handles: undefined, matched: undefined },
            onCommit: () => {
              for (const [gate, value] of revealed) gate.resolve(value);
            },
          });
        }
      }

      // The fill belongs to the visit that adopted: the entry is rewritten in
      // place, not re-cached. cacheSegmentsForHistory would advance the
      // store's nav instance and disown the adoption's handle stream, and
      // would reset the entry's stale flag.
      live.splice(0, live.length, ...reconciled.segments);
      store.setSegmentIds(matched);
      landed.streamComplete = result.streamComplete;
    } catch (thrown) {
      if (fill.cancelled) return;
      let error = thrown;
      if (error instanceof ServerRedirect) {
        if (followFillRedirect({ url: error.url }, error.state)) return;
        error = new Error(FILL_REDIRECT_NOT_FOLLOWED);
      }
      console.error("[rango] fill failed:", error);
      // Shown the way a navigation the client cannot process is
      // (navigation-bridge.ts): the error replaces the page, so an error
      // boundary takes over and no fallback is left waiting. Only on a page
      // that still waits for this fill, and not before the adoption has
      // committed: its commit would replace the error. The gates are never
      // rejected. A rejected gate is an unhandled rejection of every
      // aggregate built over it (segment-loader-promise.ts).
      if (!(await fill.whenCommitted) || !entryToFill(fill)) return;
      // What the fill pushed is not handed over once its error is on screen:
      // that update carries the adoption's tree, whose gates stay pending.
      fill.cancelled = true;
      emitNavigationError(
        onUpdate,
        toNetworkError(error, { url, operation: "navigation" }) ?? error,
        url,
      );
    } finally {
      clearPendingFill(fill.cancel);
      if (!landed.streamComplete) {
        for (const [placeholder, gate] of fill.gates) {
          releaseGate(placeholder, gate);
        }
      }
    }
  }

  async function fetchPartialUpdate(
    targetUrl: string,
    segmentIds: string[] | undefined,
    isRetry: boolean,
    signal: AbortSignal | undefined,
    tx: BoundTransaction,
    mode: UpdateMode = { type: "navigate" },
  ): Promise<void> {
    const adoption: Adoption = {};
    try {
      await applyPartialUpdate(
        adoption,
        targetUrl,
        segmentIds,
        isRetry,
        signal,
        tx,
        mode,
      );
    } finally {
      // An adoption that never committed (aborted, failed) has no tree to
      // fill: stop its request.
      if (adoption.fill && !adoption.fill.committed) adoption.fill.cancel();
    }
  }

  async function applyPartialUpdate(
    adoption: Adoption,
    targetUrl: string,
    segmentIds: string[] | undefined,
    isRetry: boolean,
    signal: AbortSignal | undefined,
    tx: BoundTransaction,
    mode: UpdateMode,
  ): Promise<void> {
    const segmentState = store.getSegmentState();
    const url = targetUrl || window.location.href;

    const historyKeyAtStart = store.getHistoryKey();

    const interceptSourceUrl = mode.interceptSourceUrl;

    let segments: string[];
    if (mode.type === "leave-intercept") {
      const currentSegments = segmentIds ?? segmentState.currentSegmentIds;
      const currentCached = getCurrentCachedSegments();
      const interceptIds = new Set(
        currentCached.filter(isInterceptSegment).map((s) => s.id),
      );
      segments = currentSegments.filter((id) => !interceptIds.has(id));
      if (IS_BROWSER_DEBUG) {
        debugLog(
          `[Browser] Leaving intercept - filtered segments: ${segments.join(", ")}`,
        );
      }
    } else {
      segments = segmentIds ?? segmentState.currentSegmentIds;
    }

    // The page the client is on, which the server diffs the target against.
    // tx.currentUrl is window.location when the transaction was created: on
    // a back/forward the popstate event had already moved it to the target,
    // and a server told the target is also the source revalidates nothing on
    // the same route, so the page being left stayed on screen (#1030). The
    // store's URL is the committed entry's until tx.commit().
    const previousUrl =
      mode.type === "leave-intercept" || (tx.traversal && !interceptSourceUrl)
        ? segmentState.currentUrl || tx.currentUrl
        : interceptSourceUrl || tx.currentUrl || segmentState.currentUrl;

    if (IS_BROWSER_DEBUG) {
      debugLog(`\n[Browser] >>> NAVIGATION`);
      debugLog(`[Browser] From: ${previousUrl}`);
      debugLog(`[Browser] To: ${url}`);
      debugLog(`[Browser] Segments to send: ${segments.join(", ")}`);
      if (interceptSourceUrl) {
        debugLog(`[Browser] Intercept context from: ${interceptSourceUrl}`);
      }
    }

    // transition({ when }). Every decision below runs before tx.commit()
    // moves the store, so `from` is still the location being left:
    // segmentState.currentUrl is the committed URL even on a popstate cache
    // miss, where tx.currentUrl and window.location already point at the
    // target.
    const whenKind: TransitionWhenKind =
      mode.type === "action"
        ? "action"
        : mode.type === "stale-revalidation" ||
            (mode.type === "navigate" && mode.refresh)
          ? "revalidate"
          : tx.traversal
            ? "pop"
            : tx.replace
              ? "replace"
              : "push";
    // Decide once per navigation (browser/transition-when.ts): reuse the
    // decision the optimistic clientUrls() swap made; otherwise decide over
    // every segment this commit presents, kept or re-sent (#989). The
    // destination state is what the commit will leave on the entry.
    const decideGatedOff = (
      segmentsToCommit: readonly ResolvedSegment[],
      metadata: {
        params?: Record<string, string>;
        routeName?: string;
        locationState?: Record<string, unknown>;
      },
    ): boolean =>
      tx.transitionGatedOff ??
      // A stale revalidation the user navigated away from is discarded after
      // the render (history-key check below): its predicate must not run.
      ((mode.type === "stale-revalidation" &&
        store.getHistoryKey() !== historyKeyAtStart) ||
        decideCommitGatedOff(store, segmentsToCommit, whenKind, {
          to: () => ({
            url,
            params: metadata.params ?? mergeSegmentParams(segmentsToCommit),
            routeName: metadata.routeName,
            state: tx.traversal
              ? addLocationState(window.history.state, metadata.locationState)
              : buildHistoryState(tx.state, undefined, metadata.locationState),
          }),
          action:
            mode.type === "action"
              ? { ...mode.action, id: mode.actionId }
              : undefined,
        }));

    const targetCache =
      mode.type === "navigate" && mode.targetCacheSegments?.length
        ? mode.targetCacheSegments
        : undefined;
    const cachedSegs = targetCache ?? getCurrentCachedSegments();
    const cachedSegsSource = targetCache ? "history-cache" : "current-page";
    if (IS_BROWSER_DEBUG) {
      debugLog(
        `[Browser] cachedSegs source: ${cachedSegsSource} (${cachedSegs.length} segments: ${cachedSegs.map((s) => s.id).join(", ")})`,
      );
    }

    // Client-run per-loader revalidation: execute the held clientUrls route's
    // revalidate() predicates now and ship their decisions with the request.
    // Fails soft to null (locked server defaults) when no group is active or
    // URLs do not parse.
    let clientRevalidation: string | null = null;
    try {
      clientRevalidation = collectClientRevalidationDecisions({
        currentUrl: new URL(previousUrl, window.location.origin),
        nextUrl: new URL(url, window.location.origin),
        // This partial fetch is a GET the server evaluates WITHOUT
        // actionContext (navigation defaults) even when it is an
        // action-triggered refetch — so the decision baseline is never the
        // action default here. Predicates still see isAction()/actionId
        // truthfully for matching.
        actionRequest: false,
        isAction: mode.type === "action",
        ...(mode.type === "action" && mode.actionId !== undefined
          ? { actionId: mode.actionId }
          : {}),
        stale: mode.type === "stale-revalidation",
      });
    } catch {
      clientRevalidation = null;
    }

    let fetchResult: Awaited<ReturnType<NavigationClient["fetchPartial"]>>;
    fetchResult = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl,
      staleRevalidation:
        mode.type === "stale-revalidation" || segments.length === 0,
      clientRevalidation,
      version: getVersion(),
      routerId: store.getRouterId?.(),
    });
    const streamingToken = tx.startStreaming();
    const {
      payload,
      streamComplete: rawStreamComplete,
      fullyPrefetched,
    } = fetchResult;
    debugLog("payload.metadata", payload.metadata);

    // Side effect only: end the streaming token once the stream settles.
    // The wrapped promise was never read as a value; only the .end() matters.
    // The .catch keeps an unhandled rejection from leaking if the stream errors.
    // A payload with deferred segments is still streaming until its fill has
    // (adoption.filled is set below, before this function first awaits).
    rawStreamComplete
      .then(() => {
        if (!adoption.filled) return streamingToken.end();
        return adoption.filled.then(() => streamingToken.end());
      })
      .catch(() => {});

    const currentRouterId = store.getRouterId?.();
    if (
      payload.metadata?.routerId &&
      currentRouterId &&
      payload.metadata.routerId !== currentRouterId
    ) {
      console.error(
        `[rango] Partial response router id "${payload.metadata.routerId}" does not ` +
          `match this client ("${currentRouterId}"); discarding it and reloading to re-sync.`,
      );
      window.location.href = url;
      return;
    }

    if (payload.metadata?.redirect) {
      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale redirect (aborted)");
        return;
      }
      // Explicit off-host redirect (redirect(url, { external: true })):
      // hard-navigate, but still scheme-validate (http/https only). external
      // waives the same-origin check the app opted out of, NOT scheme safety, so
      // a forged payload carrying a javascript:/data: URL cannot script via
      // location.assign.
      const { redirect } = payload.metadata;
      const redirectUrl = redirectTarget(redirect);
      if (!redirectUrl) {
        debugLog(
          redirect.external
            ? "[Browser] Ignoring blocked external redirect payload"
            : "[Browser] Ignoring blocked redirect payload",
        );
        return;
      }
      if (redirect.external) {
        debugLog("[Browser] External redirect (hard navigation)");
        window.location.assign(redirectUrl);
        return;
      }
      throw new ServerRedirect(redirectUrl, payload.metadata.locationState);
    }

    if (payload.metadata?.isPartial) {
      const { segments: newSegments, matched, diff } = payload.metadata;

      // Check if this navigation is stale (a newer one started)
      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted)");
        return;
      }

      if (IS_BROWSER_DEBUG) {
        debugLog(`[Browser] Partial update - matched: ${matched?.join(", ")}`);
        debugLog(`[Browser] Diff: ${diff?.join(", ")}`);
      }

      if (!diff || diff.length === 0) {
        const matchedIds = matched || [];
        const cacheMap = new Map(cachedSegs.map((s) => [s.id, s]));
        const existingSegments = matchedIds
          .map((id: string) => cacheMap.get(id))
          .filter(Boolean) as ResolvedSegment[];

        if (mode.type === "navigate" && targetCache) {
          debugLog(
            "[Browser] No diff but navigating with cached segments - rendering target route",
          );

          const cachedGatedOff = decideGatedOff(
            existingSegments,
            payload.metadata,
          );
          const newTree = await renderSegments(existingSegments, {
            forceAwait: true,
            transitionGatedOff: cachedGatedOff,
          });

          const { scroll: commitScroll } = tx.commit(
            matchedIds,
            existingSegments,
            { routeName: payload.metadata.routeName },
          );

          if (mode.targetCacheHandleData) {
            store.updateCacheHandleData(
              store.getHistoryKey(),
              mode.targetCacheHandleData,
            );
          }

          const { handles: _unusedHandles, ...metadataWithoutHandles } =
            payload.metadata!;
          const cachedUpdate = {
            root: newTree,
            metadata: {
              ...metadataWithoutHandles,
              cachedHandleData: mode.targetCacheHandleData,
            },
            ...(commitScroll && { scroll: commitScroll }),
          };

          if (shouldStartViewTransition(existingSegments, cachedGatedOff)) {
            commitInTransition(onUpdate, existingSegments, cachedUpdate, [
              "navigation",
            ]);
          } else {
            onUpdate(cachedUpdate);
          }

          debugLog("[Browser] Navigation complete (rendered from cache)");
          return;
        }

        if (mode.type === "leave-intercept") {
          debugLog(
            "[Browser] Leaving intercept - forcing re-render to remove modal",
          );

          const newTree = await renderSegments(existingSegments, {
            forceAwait: true,
          });

          const { scroll: leaveScroll } = tx.commit(
            matchedIds,
            existingSegments,
            { routeName: payload.metadata.routeName },
          );

          onUpdate({
            root: newTree,
            metadata: payload.metadata,
            ...(leaveScroll && { scroll: leaveScroll }),
          });

          debugLog("[Browser] Navigation complete (left intercept)");
          return;
        }

        debugLog(
          "[Browser] No changes - all revalidations returned false, keeping existing UI",
        );
        tx.commit(matchedIds, existingSegments, {
          routeName: payload.metadata.routeName,
          treeless: true,
        });
        debugLog("[Browser] Navigation complete (no re-render)");
        return;
      }

      const matchedIds = matched || [];
      const actor: ReconcileActor =
        mode.type === "stale-revalidation" || mode.type === "action"
          ? "stale-revalidation"
          : "navigation";

      // prefetch: false. A payload that carries deferred segments (an adopted
      // prefetch, whatever answered it) commits at once with a gate in place
      // of each missing value, and one fill request fetches them.
      let fill: Fill | undefined;
      let heldIds = matchedIds;
      if (newSegments?.some((s) => s.deferred)) {
        const placeholders = newSegments.filter((s) => s.deferred);
        fill = armGates(placeholders, matchedIds);
        // A placeholder is not held: every later request from this page
        // leaves its id out, so the server renders it.
        const deferredIds = new Set(placeholders.map((s) => s.id));
        heldIds = matchedIds.filter((id) => !deferredIds.has(id));
      }

      const reconciled = reconcileSegments({
        actor,
        matched: matchedIds,
        diff: diff || [],
        serverSegments: newSegments || [],
        cachedSegments: cachedSegs,
        insertMissingDiff: true,
      });

      const reconciledIdSet = new Set(reconciled.segments.map((s) => s.id));
      const missingIds = matchedIds.filter(
        (id: string) => !reconciledIdSet.has(id),
      );

      if (missingIds.length > 0) {
        const missingCount = missingIds.length;

        if (isRetry) {
          console.warn("Missing ids", { missingIds });
          throw new Error(
            `[Browser] Failed to fetch segments after retry. Missing: [${missingIds.join(", ")}]`,
          );
        }
        if (signal?.aborted) {
          debugLog(
            "[Browser] Ignoring stale navigation (aborted during HMR retry)",
          );
          return;
        }
        if (mode.type === "action") {
          // An action refetch that lands on missing segments (navigated away /
          // consolidation / HMR) drops rather than refetch-all: the action flow
          // is storeOnly / skipLoadingState, so a full refetch here would fight
          // it. Keep the stale-but-consistent tree; log so the drop is visible.
          debugLog(
            `[Browser] Action refetch: ${missingCount} segments missing; dropping (stale-but-consistent tree kept).`,
          );
          return;
        }
        console.warn(
          `[Browser] HMR detected: Missing ${missingCount} segments. Refetching all...`,
        );

        return fetchPartialUpdate(url, [], true, signal, tx, mode);
      }

      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted before render)");
        return;
      }

      // Decide before the tree is built: on a gated-off commit every segment
      // keeps its <ViewTransition> with "none" classes, so the decision must
      // reach renderSegments. The response carries no decision, so a reused
      // prefetch is decided against the real source.
      const gatedOff = decideGatedOff(reconciled.segments, payload.metadata);

      // The fill starts now, beside the render and the commit, not after
      // them. It lists what the client holds once this payload commits.
      if (fill) {
        adoption.fill = fill;
        adoption.filled = runFill(fill, url, heldIds, gatedOff);
      }
      const renderOptions = {
        transitionGatedOff: gatedOff,
        isAction: mode.type === "action",
        // forceAwait unwraps the ROUTER loader promises during render so they
        // land without a loading()/fallback frame. A fully-prefetched nav has
        // its router data already resolved (the prefetch stream drained), so
        // awaiting it here is free; the commit below then runs in a transition
        // (fullyPrefetched branch) so nothing router-owned can flash.
        forceAwait: mode.type === "stale-revalidation" || fullyPrefetched,
        interceptSegments:
          reconciled.interceptSegments.length > 0
            ? reconciled.interceptSegments
            : undefined,
      };
      let newTree: Awaited<ReturnType<typeof renderSegments>>;
      if (signal) {
        // Race render against abort. Store the abort handler and register it
        // { once:true } so a non-aborted render (which wins the race) can
        // remove it in finally — otherwise the listener stays attached and the
        // rejecting promise never settles. Mirrors teeWithCompletion in
        // browser/response-adapter.ts.
        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new DOMException("Navigation aborted", "AbortError"));
            return;
          }
          onAbort = () =>
            reject(new DOMException("Navigation aborted", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          newTree = await Promise.race([
            renderSegments(reconciled.mainSegments, renderOptions),
            abortPromise,
          ]);
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      } else {
        newTree = await renderSegments(reconciled.mainSegments, renderOptions);
      }

      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted before commit)");
        return;
      }

      const isInterceptResponse = hasActiveInterceptSlots(
        payload.metadata?.slots,
      );

      // Same-structure revalidation: every segment this commit will render
      // already exists on screen (by id) — the navigation mounts nothing new,
      // it only refreshes what the user is looking at. The hold this enables
      // manifests on SEARCH-only navs (filters, tabs — search is never in the
      // segment key, so the subtree reconciles); a PARAM nav outside a
      // transition() scope still remounts via its param-bearing key
      // (segment-system.tsx) and reveals its fresh skeleton inside the
      // transition, unchanged. Compared against the CURRENT page's cache, not
      // cachedSegs: for a popstate restore cachedSegs is the TARGET's history
      // cache, which says nothing about what is visible now. Restricted to
      // plain navigations — leave-intercept must close its modal urgently,
      // and action/stale modes have their own transition branch.
      const onScreenIds = new Set(getCurrentCachedSegments().map((s) => s.id));
      const isSameStructureNav =
        mode.type === "navigate" &&
        reconciled.segments.every((s) => onScreenIds.has(s.id));

      const effectiveInterceptSource =
        interceptSourceUrl || segmentState.currentUrl;
      if (mode.type !== "action" && mode.type !== "stale-revalidation") {
        if (isInterceptResponse) {
          store.setInterceptSourceUrl(effectiveInterceptSource);
        } else {
          store.setInterceptSourceUrl(null);
        }
      }

      const serverLocationState = payload.metadata?.locationState;
      const overrides: CommitOverrides = {
        routeName: payload.metadata?.routeName,
        ...(isInterceptResponse && {
          scroll: false,
          intercept: true,
          interceptSourceUrl: effectiveInterceptSource,
        }),
        ...(serverLocationState && { serverState: serverLocationState }),
      };
      const { scroll: navScroll } = tx.commit(
        heldIds,
        reconciled.segments,
        overrides,
      );
      const hasTransition = shouldStartViewTransition(
        reconciled.segments,
        gatedOff,
      );
      // After tx.commit(), which cancels the fill of the page being left.
      let root: NavigationUpdate["root"] = newTree;
      if (fill) {
        fill.root = newTree;
        fill.forceAwait = renderOptions.forceAwait;
        if (hasTransition && fill.units.length > 0) {
          root = new Promise((resolve) => {
            fill!.land = resolve;
          });
        }
        fill.commit();
      }

      if (mode.type === "stale-revalidation") {
        const historyKeyNow = store.getHistoryKey();
        if (historyKeyNow !== historyKeyAtStart) {
          debugLog(
            `[Browser] Stale revalidation: history key changed (${historyKeyAtStart} -> ${historyKeyNow}), skipping UI update`,
          );
          return;
        }
      }

      debugLog("[partial-update] updating document");

      const optimisticPresented =
        mode.type === "navigate" && mode.optimisticPresented === true;
      // [VT-DIAG] Gated behind INTERNAL_RANGO_DEBUG. Reports which reconciled
      // segment still carries a transition after the server-side when-gate, and
      // whether the commit will be held in a startTransition. If `withTransition`
      // lists an ancestor (layout/root) id rather than the gated leaf, an ungated
      // ancestor transition is holding the subtree (missing loading() fallback).
      if (isBrowserDebugEnabled()) {
        debugLog("[VT-DIAG] commit", {
          mode: mode.type,
          hasTransition,
          withTransition: reconciled.segments
            .filter((s) => s.transition)
            .map((s) => s.id),
          transitionGatedOff: gatedOff,
          all: reconciled.segments.map((s) => s.id),
        });
      }
      // Refresh the browser-local intercept-target set for the location being
      // committed — the clientUrls matcher declines optimistic presentation
      // for targets an intercept would claim from here. Back/forward commits
      // served purely from the history cache keep the previous set (no fresh
      // metadata); popstate navigations get no optimistic presentation anyway.
      setActiveInterceptTargets(payload.metadata?.interceptTargets);

      // No scroll for a commit that is not a navigation (an action refetch):
      // navigation-transaction.ts CommitResult.
      // An adoption that waits for a fill reads `loading` until React
      // commits it (pending-fill.ts emitAdoption).
      const emit: UpdateSubscriber = fill
        ? (next) => emitAdoption(() => onUpdate(next))
        : onUpdate;
      const update: NavigationUpdate = {
        root,
        metadata: payload.metadata!,
        ...(navScroll && { scroll: navScroll }),
        onCommit: fill?.show,
      };
      if (
        !gatedOff &&
        (mode.type === "action" || mode.type === "stale-revalidation")
      ) {
        commitInTransition(
          emit,
          reconciled.mainSegments,
          update,
          hasTransition ? ["action"] : [],
        );
      } else if (hasTransition) {
        commitInTransition(
          emit,
          reconciled.mainSegments,
          update,
          optimisticPresented
            ? ["navigation", OPTIMISTIC_COMMIT_TRANSITION_TYPE]
            : ["navigation"],
        );
      } else if (
        !gatedOff &&
        (fullyPrefetched || isSameStructureNav || optimisticPresented)
      ) {
        // Content-hold commit, two triggers. Fully-prefetched nav: the payload
        // is fully resolved (forceAwait above), so the transition commits
        // synchronously — no fallback flash. Same-structure nav: the re-run
        // loaders are still streaming, and an urgent commit would re-suspend
        // the ALREADY-REVEALED boundaries — replacing visible content with its
        // own fallback for the loader's full duration (the PLP filter-change
        // flash). Inside a transition React holds the current UI until the
        // suspended data lands, the action treatment; nothing new mounts (by
        // the isSameStructureNav definition), so no fallback is being withheld
        // from a first paint. No addTransitionType: this is the React
        // content-hold, not a view transition. Deliberate trade-off (#622
        // introduced, #624 reverted, then reinstated): a client component that
        // suspends during its FIRST render (use() of a promise created at
        // mount — see ClientMountSuspense in the e2e test-app) under an
        // ALREADY-REVEALED boundary holds the old content until it resolves
        // instead of revealing that boundary's fallback; its render happens
        // pre-commit inside the transition, so userland effects cannot run
        // first. Boundaries newly mounted by this nav still reveal their
        // fallbacks (React shows new boundaries inside transitions). An
        // optimistic clientUrls() presentation commits here too: the group
        // segment reconciles in place (clientGroup key), so a read that still
        // suspends must hold the presented content, not flash a fallback.
        commitInTransition(
          emit,
          reconciled.mainSegments,
          update,
          optimisticPresented ? [OPTIMISTIC_COMMIT_TRANSITION_TYPE] : [],
        );
      } else {
        // Cold/partially-prefetched nav that mounts NEW segments, or any
        // commit transition({ when }) gated off (navigation, action refetch,
        // stale revalidation): normal commit so fallbacks stream
        // like a first load and the click has visible feedback. A gated-off
        // segment keeps its key, so its loading() fallback comes from its
        // boundary re-suspending on this urgent commit, not from a remount
        // (#995). Explicit transition() routes keep the content-hold via the
        // hasTransition branch above (the opt-in).
        emit(update);
      }

      debugLog("[Browser] Navigation complete");
      return;
    } else {
      console.warn(`[Browser] Full update (fallback)`);

      const segments = payload.metadata?.segments || [];

      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted)");
        return;
      }

      const segmentIds = segments.map((s: ResolvedSegment) => s.id);

      const fullGatedOff = decideGatedOff(segments, payload.metadata ?? {});
      const newTree = await renderSegments(segments, {
        transitionGatedOff: fullGatedOff,
      });

      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted before commit)");
        return;
      }

      const fullUpdateServerState = payload.metadata?.locationState;
      const { scroll: fullScroll } = tx.commit(segmentIds, segments, {
        routeName: payload.metadata?.routeName,
        ...(fullUpdateServerState && { serverState: fullUpdateServerState }),
      });

      const fullHasTransition = shouldStartViewTransition(
        segments,
        fullGatedOff,
      );
      const fullUpdate: NavigationUpdate = {
        root: newTree,
        metadata: payload.metadata!,
        ...(fullScroll && { scroll: fullScroll }),
      };

      if (mode.type === "stale-revalidation") {
        await rawStreamComplete;
        // Mirror the partial branch's history-key staleness guard (above): the
        // await above is a real async suspension, so the user may have navigated
        // away while this background revalidation was draining. Dropping a late
        // full-update here prevents it from clobbering the freshly committed UI
        // of the page the user moved to.
        const historyKeyNow = store.getHistoryKey();
        if (historyKeyNow !== historyKeyAtStart) {
          debugLog(
            `[Browser] Stale revalidation (full update): history key changed (${historyKeyAtStart} -> ${historyKeyNow}), skipping UI update`,
          );
          return;
        }
        if (fullGatedOff) onUpdate(fullUpdate);
        else {
          commitInTransition(
            onUpdate,
            segments,
            fullUpdate,
            fullHasTransition ? ["action"] : [],
          );
        }
      } else if (mode.type === "action" && !fullGatedOff) {
        commitInTransition(
          onUpdate,
          segments,
          fullUpdate,
          fullHasTransition ? ["action"] : [],
        );
      } else if (fullHasTransition) {
        commitInTransition(onUpdate, segments, fullUpdate, ["navigation"]);
      } else {
        onUpdate(fullUpdate);
      }

      return;
    }
  }

  return fetchPartialUpdate;
}

export { createPartialUpdater as default };
