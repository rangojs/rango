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
import { Defer } from "./defer.js";
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
import { validatePayloadRedirect } from "./validate-redirect-origin.js";
import type { HandleData, NavigationUpdate, RscMetadata } from "./types.js";
import { OPTIMISTIC_COMMIT_TRANSITION_TYPE } from "./optimistic-commit.js";
import type { LoaderStore } from "../loader-store.js";
import { setActiveInterceptTargets } from "../client-urls/navigation.js";
import {
  decideCommitGatedOff,
  mergeSegmentParams,
  type TransitionWhenActionInput,
} from "./transition-when.js";
import { buildHistoryState } from "./history-state.js";
import { addLocationState } from "./react/location-state-shared.js";
import { isPlaceholder, type TransitionWhenKind } from "../types/segments.js";
import { auditTreeCause, type TreeUpdateCause } from "../suspense-audit.js";

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

// Dev only (suspense-audit.ts I6): what this updater's commit is.
function treeCause(mode: UpdateMode, traversal?: boolean): TreeUpdateCause {
  if (mode.type === "action") return "action";
  if (mode.type === "stale-revalidation") return "stale-revalidation";
  return traversal ? "popstate" : "navigation";
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
  loaders: LoaderStore,
  onUpdate: UpdateSubscriber,
  segments: readonly ResolvedSegment[],
  update: NavigationUpdate,
  transitionTypes: readonly string[],
): void {
  startTransition(() => {
    loaders.announcePendingStreams(segments);
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
   * A fill (`prefetch: false`) lands after its navigation has committed: the
   * transaction has recorded the entry and handed React the tree, and the
   * fill hands React no update that would carry what its response holds to
   * the stores. The bridge that owns navigation supplies the writes, the
   * ones its own updates make. Without them a redirect is a document
   * navigation and the rest is dropped.
   */
  fill?: {
    redirect(url: string, state?: Record<string, unknown>): void;
    /** The location state the server set, to the entry and its readers. */
    locationState(state: Record<string, unknown>): void;
    /** What the response's handlers pushed, to the handle store. */
    handles(metadata: RscMetadata): void;
    /**
     * Deliver the navigation state to its readers now. A page built with
     * holes commits in the task of its click, before the notification of the
     * click has gone out (event-controller.ts makeDebouncedNotifier), and
     * React holds that commit where a hole is read with no boundary: without
     * this useNavigation() reads idle, on the page being left, for the whole
     * wait. Delivered first, `loading` is on screen when the commit is
     * handed over, and stays while React holds it, as for a plain click.
     */
    flush(): void;
  };
}

const FILL_REDIRECT_NOT_FOLLOWED = "[rango] fill: redirect not followed";

/** Rewrite `into` in place: its holders keep the array. */
function replace<T>(into: T[], items: readonly T[]): void {
  into.splice(0, into.length, ...items);
}

/** The ids of `matched` that `segments` lacks. */
function missingIds(
  matched: readonly string[],
  segments: readonly ResolvedSegment[],
): string[] {
  const ids = new Set(segments.map((s) => s.id));
  return matched.filter((id) => !ids.has(id));
}

/**
 * A tree built with holes: one defer per placeholder segment, standing for
 * the value its work did not produce. The segment is always new to the page:
 * a payload that defers is adopted only on the page it was prefetched from,
 * with the segments it was prefetched with (rsc/rsc-rendering.ts
 * sourceScoped, prefetch/cache.ts buildSourceKey), and the server defers
 * nothing that request listed as held. The navigation that commits the tree
 * fills it from its fill request (fillHoles) or, when it is left first,
 * releases it (docs/design/prefetch-false.md, "The browser").
 */
interface Holes {
  /** Placeholder segment (the payload's object) -> its defer. */
  defers: Map<ResolvedSegment, Defer<unknown>>;
  /** The `matched` the tree was built for. */
  matched: string[];
  /** The answer to the fill request this navigation sent for them. */
  answer: ReturnType<NavigationClient["fetchPartial"]>;
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
      /** The handle state of `targetCacheSegments`: the entry's pushes, and
       * the live pushes of the page on screen for each segment taken from it.
       * Read at commit; the page starts from it and the response's handles,
       * when it has any, merge onto it (NavigationProvider). */
      targetCacheHandleData?: () => HandleData;
      /** Source URL for intercept restore (popstate cache miss) */
      interceptSourceUrl?: string;
      /**
       * The optimistic clientUrls() destination the bridge presented for
       * this navigation. Transition-lane commits add
       * OPTIMISTIC_COMMIT_TRANSITION_TYPE so router <ViewTransition>
       * boundaries do not animate the identical repaint, and `clear()` runs
       * once the canonical tree is handed to React: `useOutlet().pending`
       * ends with that commit, not with a `prefetch: false` fill after it.
       */
      presentation?: { clear(): void };
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
    return (entryOnScreen() || []).filter((s) => !isPlaceholder(s));
  }

  /**
   * One defer per placeholder: a loader's is its `loaderData`, any other
   * segment's is its `component`. Every reader of a hole (Suspender,
   * useLoader, React itself where a segment has no loading()) reads it as a
   * stream that has not arrived yet, and all of them wait on its one promise
   * (browser/defer.ts readDefer, asStream).
   */
  function armHoles(
    placeholders: ResolvedSegment[],
  ): Map<ResolvedSegment, Defer<unknown>> {
    const defers = new Map<ResolvedSegment, Defer<unknown>>();
    for (const segment of placeholders) {
      const hole = new Defer<unknown>();
      if (segment.type === "loader") segment.loaderData = hole;
      else segment.component = hole as unknown as ReactNode;
      defers.set(segment, hole);
    }
    return defers;
  }

  /**
   * A defer that will not be resolved must not stay a pending stream. It is
   * never rejected either: a rejection is unhandled in every aggregate built
   * over it (segment-loader-promise.ts).
   */
  function releaseHoles(holes: Holes): void {
    for (const [placeholder, hole] of holes.defers) {
      if (placeholder.type === "loader") {
        store.loaders.releasePendingStream(placeholder.loaderId!, hole.promise);
      }
    }
  }

  /**
   * The entry on screen, while it still holds these placeholders. By object,
   * not by history key: a shallow navigation that copied the entry to a new
   * key is still the page the answer is for, and an action refetch that
   * already rendered the missing segments is not.
   */
  function entryToFill(holes: Holes): ResolvedSegment[] | undefined {
    const live = entryOnScreen();
    return live?.some((s) => holes.defers.has(s)) ? live : undefined;
  }

  /** The page on screen holds every one of `segments` (by id). */
  function holdsAll(segments: ResolvedSegment[]): boolean {
    const onScreenIds = new Set(getCurrentCachedSegments().map((s) => s.id));
    return segments.every((s) => onScreenIds.has(s.id));
  }

  function entryOnScreen(): ResolvedSegment[] | undefined {
    return store.getCachedSegments(store.getHistoryKey())?.segments;
  }

  /**
   * Act on the redirect a navigation was answered with. True when `metadata`
   * carried one: the navigation is done here. A target in the app is thrown
   * for the bridge to follow. An explicit off-host one
   * (redirect(url, { external: true })) is a hard navigation, still
   * scheme-validated (http/https only): `external` waives the same-origin
   * check the app opted out of, not scheme safety, so a forged payload
   * carrying a javascript: or data: URL cannot script via location.assign. A
   * target the client refuses is dropped.
   */
  function redirected(metadata: RscMetadata | undefined): boolean {
    const redirect = metadata?.redirect;
    if (!redirect) return false;
    const target = validatePayloadRedirect(redirect);
    if (!target) {
      debugLog("[Browser] Ignoring blocked redirect payload");
    } else if (redirect.external) {
      debugLog("[Browser] External redirect (hard navigation)");
      window.location.assign(target);
    } else {
      throw new ServerRedirect(target, metadata.locationState);
    }
    return true;
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
    const target = validatePayloadRedirect(redirect);
    if (!target) return false;
    if (redirect.external || !config.fill) window.location.assign(target);
    else config.fill.redirect(target, state);
    return true;
  }

  /**
   * Fill the holes of the tree this navigation committed with its fill's
   * answer (`holes.answer`): a partial payload that carries the segment each placeholder
   * stands for. Each defer resolves with that segment's value, the stored
   * entry is rewritten with the segments themselves, and what the answer's
   * handlers pushed and the location state they set go to the stores their
   * readers subscribe to. React is handed nothing: the tree that reads the
   * defers is the page, and what resolves reaches it as a stream that
   * arrived.
   *
   * Called after tx.commit(), so the answer can never land before the tree it
   * fills. The navigation's signal is the one thing that cancels it: a newer
   * navigation or a back/forward aborts the request while it waits for its
   * response (navigation-client.ts), and an answer that arrives after the
   * abort is dropped. Either way the defers are released, not resolved.
   *
   * One answer does replace the page: one whose segments are not the ones the
   * tree was built for. A handler that was awaited threw or called
   * notFound(), and its entry's segments are one error segment instead
   * (router/segment-resolution/helpers.ts catchSegmentError). That is the
   * outcome of the navigation, and the segments are rendered as a
   * navigation's are. `gatedOff` is the tree's transition({ when }) decision,
   * for that render.
   *
   * Never rejects.
   */
  async function fillHoles(
    holes: Holes,
    signal: AbortSignal | undefined,
    url: string,
    gatedOff: boolean,
  ): Promise<void> {
    let filled = false;
    try {
      const result = await holes.answer;
      // A page that no longer waits for the answer (an action refetch
      // rendered what the placeholders stand for) takes nothing of it, its
      // redirect included.
      const live = entryToFill(holes);
      if (signal?.aborted || !live) return;

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

      const matched = metadata.matched || [];
      const reconciled = reconcileSegments({
        actor: "stale-revalidation",
        matched,
        diff: metadata.diff || [],
        serverSegments: metadata.segments || [],
        cachedSegments: live.filter((s) => !isPlaceholder(s)),
        insertMissingDiff: true,
      });
      const missing = missingIds(matched, reconciled.segments);
      if (missing.length > 0) {
        throw new Error(
          `[rango] fill: missing segments [${missing.join(", ")}]`,
        );
      }

      // Nothing of the answer is handed over before this point: what an
      // answer the client then refuses had set would stay under the error.
      if (metadata.locationState) {
        config.fill?.locationState(metadata.locationState);
      }

      const placeholders = [...holes.defers.keys()];
      const answers = placeholders.map((placeholder) =>
        reconciled.segments.find(
          (s) => s.id === placeholder.id && s.type === placeholder.type,
        ),
      );
      if (
        answers.includes(undefined) ||
        matched.join() !== holes.matched.join()
      ) {
        // The tree's handle stream (NavigationProvider processHandles) reads
        // this array on every yield and drops the buckets of segments
        // outside it.
        replace(holes.matched, matched);
        // Each place a hole stood is handed its defer again, resolved with
        // what the answer put there, and its reader applies the read rule
        // (browser/defer.ts): a reader that suspended on it while it mounted
        // calls use() of the same promise, which React has marked; one React
        // never read (a hole below another one) reads the value, so this
        // urgent update shows no fallback the plain click does not show
        // (navigation-adoption-loading.test.tsx, "a failed route's error").
        const settled = new Map<ResolvedSegment, ResolvedSegment>();
        for (const [placeholder, hole] of holes.defers) {
          if (placeholder.type === "loader") continue;
          // By id alone: an error segment takes its route's place.
          const next = reconciled.mainSegments.find(
            (s) => s.id === placeholder.id,
          );
          if (next && !(next.component instanceof Promise)) {
            hole.resolve(next.component);
            settled.set(next, {
              ...next,
              component: hole as unknown as ReactNode,
            });
          }
        }
        const main = reconciled.mainSegments.map((s) => settled.get(s) ?? s);
        const root = await renderSegments(main, {
          transitionGatedOff: gatedOff,
          interceptSegments:
            reconciled.interceptSegments.length > 0
              ? reconciled.interceptSegments
              : undefined,
        });
        if (signal?.aborted || entryOnScreen() !== live) return;
        releaseHoles(holes);
        // The navigation's outcome (see fillHoles), so its cause.
        if (process.env.NODE_ENV !== "production") {
          auditTreeCause("navigation");
        }
        // No `scroll`: the transaction decided it with the click's update.
        // A decision here, even "do not scroll", would replace that pending
        // one (NavigationProvider).
        onUpdate({ root, metadata });
      } else {
        config.fill?.handles(metadata);
        // All in one task, each with its own stream or node: a hole below
        // another one is read in the render the outer one's resolution
        // starts. Resolved by then with a node, it costs that render nothing
        // where a router reader reads it (browser/defer.ts readDefer); with a
        // stream, or where React reads the node itself, one microtask. Not a
        // fallback.
        placeholders.forEach((placeholder, index) => {
          const next = answers[index]!;
          holes.defers
            .get(placeholder)!
            .resolve(
              placeholder.type === "loader" ? next.loaderData : next.component,
            );
        });
      }

      // The entry keeps the answer's own streams and nodes, not the defers:
      // a defer belongs to the tree on screen, and the next render from this
      // page builds on the entry. The answer belongs to the visit that built
      // the tree: the entry is rewritten in place, not re-cached.
      // cacheSegmentsForHistory would advance the store's nav instance and
      // disown the tree's handle stream, and would reset the entry's stale
      // flag.
      replace(live, reconciled.segments);
      store.setSegmentIds(matched);
      filled = true;
    } catch (thrown) {
      // Only on a page that still waits for this answer.
      if (signal?.aborted || !entryToFill(holes)) return;
      let error = thrown;
      if (error instanceof ServerRedirect) {
        if (followFillRedirect({ url: error.url }, error.state)) return;
        error = new Error(FILL_REDIRECT_NOT_FOLLOWED);
      }
      console.error("[rango] fill failed:", error);
      // Shown the way a navigation the client cannot process is
      // (navigation-bridge.ts): the error replaces the page, so an error
      // boundary takes over and no fallback is left waiting.
      emitNavigationError(
        onUpdate,
        toNetworkError(error, { url, operation: "navigation" }) ?? error,
        url,
      );
    } finally {
      if (!filled) releaseHoles(holes);
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
    // Rendered from the history cache, the page starts from the entry's
    // pushes whether or not the response re-renders. Read before tx.commit():
    // it records the controller's handle state (the document snapshot during
    // the hydration window) in the entry it commits, which for a link to the
    // page on screen's own URL is the entry this reads. Written over that
    // record after it.
    const readCachedHandleData =
      targetCache && mode.type === "navigate"
        ? mode.targetCacheHandleData
        : undefined;
    if (IS_BROWSER_DEBUG) {
      debugLog(
        `[Browser] cachedSegs source: ${cachedSegsSource} (${cachedSegs.length} segments: ${cachedSegs.map((s) => s.id).join(", ")})`,
      );
    }

    let fetchResult: Awaited<ReturnType<NavigationClient["fetchPartial"]>>;
    fetchResult = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl,
      staleRevalidation:
        mode.type === "stale-revalidation" || segments.length === 0,
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
    // (`filled` is set below, before this function first awaits). A
    // navigation that is left ignores its response, which is never cancelled
    // (navigation-client.ts): it streams to its end, and stops counting as
    // streaming at the abort.
    let filled: Promise<unknown> | undefined;
    const endStream = (): void => {
      signal?.removeEventListener("abort", endStream);
      streamingToken.end();
    };
    signal?.addEventListener("abort", endStream);
    rawStreamComplete
      .then(() => (filled ? filled.then(endStream) : endStream()))
      .catch(() => {});

    if (signal?.aborted) {
      endStream();
      debugLog("[Browser] Ignoring stale navigation (aborted)");
      return;
    }

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

    if (redirected(payload.metadata)) return;

    if (payload.metadata?.isPartial) {
      const { segments: newSegments, matched, diff } = payload.metadata;
      let serverSegments = newSegments || [];
      let sent = diff || [];

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
          if (signal?.aborted) return;

          const cachedHandleData = readCachedHandleData?.();
          const { scroll: commitScroll } = tx.commit(
            matchedIds,
            existingSegments,
            { routeName: payload.metadata.routeName },
          );
          if (cachedHandleData) {
            store.updateCacheHandleData(
              store.getHistoryKey(),
              cachedHandleData,
            );
          }

          const { handles: _unusedHandles, ...metadataWithoutHandles } =
            payload.metadata!;
          const cachedUpdate = {
            root: newTree,
            metadata: { ...metadataWithoutHandles, cachedHandleData },
            ...(commitScroll && { scroll: commitScroll }),
          };

          if (process.env.NODE_ENV !== "production") {
            auditTreeCause(treeCause(mode, tx.traversal));
          }
          if (shouldStartViewTransition(existingSegments, cachedGatedOff)) {
            commitInTransition(
              store.loaders,
              onUpdate,
              existingSegments,
              cachedUpdate,
              ["navigation"],
            );
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
          if (signal?.aborted) return;

          const { scroll: leaveScroll } = tx.commit(
            matchedIds,
            existingSegments,
            { routeName: payload.metadata.routeName },
          );

          if (process.env.NODE_ENV !== "production") {
            auditTreeCause(treeCause(mode, tx.traversal));
          }
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

      let matchedIds = matched || [];
      const actor: ReconcileActor =
        mode.type === "stale-revalidation" || mode.type === "action"
          ? "stale-revalidation"
          : "navigation";

      // prefetch: false. A payload that carries deferred segments (an adopted
      // prefetch, whatever answered it) is the page with holes in it: one
      // placeholder per segment whose work did not run, each with what its
      // wrapper chain is built from. The tree is built once, with a deferred
      // in place of each missing value, and this navigation fills them from
      // one fill request once it has committed the tree.
      let defers: Holes["defers"] | undefined;
      let heldIds = matchedIds;
      const placeholders = serverSegments.filter(isPlaceholder);
      if (placeholders.length > 0) {
        defers = armHoles(placeholders);
        // A placeholder is not held: every later request from this page
        // leaves its id out, so the server renders it.
        const deferredIds = new Set(placeholders.map((s) => s.id));
        heldIds = matchedIds.filter((id) => !deferredIds.has(id));
      }

      const reconcile = () =>
        reconcileSegments({
          actor,
          matched: matchedIds,
          diff: sent,
          serverSegments,
          cachedSegments: cachedSegs,
          insertMissingDiff: true,
        });
      let reconciled = reconcile();

      const missing = missingIds(matchedIds, reconciled.segments);

      if (missing.length > 0) {
        const missingCount = missing.length;

        if (isRetry) {
          console.warn("Missing ids", { missingIds: missing });
          throw new Error(
            `[Browser] Failed to fetch segments after retry. Missing: [${missing.join(", ")}]`,
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

      const isInterceptResponse = hasActiveInterceptSlots(
        payload.metadata?.slots,
      );
      // The source the commit records for an intercept, and its fill's.
      const effectiveInterceptSource =
        interceptSourceUrl || segmentState.currentUrl;

      // The fill: one request for what the prefetch deferred, listing what
      // the client holds once this payload commits. It leaves now, before
      // the tree is rendered, with this navigation's signal.
      let holes: Holes | undefined;
      if (defers) {
        holes = {
          defers,
          matched: matchedIds,
          answer: client.fetchPartial({
            targetUrl: url,
            segmentIds: heldIds,
            // The page the fill completes is the page it is on: from the
            // target itself nothing intercepts, so an intercept's fill names
            // its source, as a request from the open modal does.
            previousUrl: isInterceptResponse ? effectiveInterceptSource : url,
            ...(isInterceptResponse && {
              interceptSourceUrl: effectiveInterceptSource,
            }),
            fill: true,
            signal,
            version: getVersion(),
            routerId: store.getRouterId?.(),
          }),
        };
        filled = holes.answer
          .then((answer) => answer.streamComplete)
          .catch(() => {});
      }

      // What a fill brought for a page that waited for it (below).
      let waited: RscMetadata | undefined;
      if (
        holes &&
        placeholders.some((s) => s.type !== "loader") &&
        shouldStartViewTransition(reconciled.segments, gatedOff)
      ) {
        // A deferred handler on a page that commits in a transition. React
        // renders such a page's content in the commit that shows its
        // fallback, in a render that can wait: a plain click commits it with
        // its response, URL, hooks and page together. Committed with the
        // click and filled afterwards, the URL moved a round trip before the
        // page, and no later commit could bring the content in without a
        // view transition the plain click does not start (measured: three
        // for two, the content up to 280 ms late). So this click is a
        // navigation that waits for its fill: nothing commits until the
        // fill's first chunk, and then the page commits once, from the
        // prefetched segments and the fill's, with no hole in it.
        const { answer } = holes;
        holes = undefined;
        waited = (await answer).payload.metadata;
        if (signal?.aborted || redirected(waited)) return;
        if (waited?.isPartial) {
          matchedIds = heldIds = waited.matched || [];
          serverSegments = [
            ...serverSegments.filter((s) => !isPlaceholder(s)),
            ...(waited.segments || []),
          ];
          sent = [...sent, ...(waited.diff || [])];
          reconciled = reconcile();
          if (waited.locationState) {
            payload.metadata.locationState = {
              ...payload.metadata.locationState,
              ...waited.locationState,
            };
          }
        }
        // The two answers do not make the page (the routes changed between
        // the prefetch and the click): start over with nothing held, as a
        // navigation whose own response misses segments does above. That
        // request is never answered from a prefetch, so it defers nothing.
        if (
          !waited?.isPartial ||
          missingIds(matchedIds, reconciled.segments).length > 0
        ) {
          return fetchPartialUpdate(url, [], true, signal, tx, mode);
        }
      } else if (holes) {
        config.fill?.flush();
      }
      const renderOptions = {
        transitionGatedOff: gatedOff,
        isAction: mode.type === "action",
        // forceAwait unwraps the ROUTER loader promises during render so they
        // land without a loading()/fallback frame. A fully-prefetched nav has
        // its router data already resolved (the prefetch stream drained), so
        // awaiting it here is free; the commit below then runs in a transition
        // (fullyPrefetched branch) so nothing router-owned can flash. A page
        // that waited for its fill is still streaming it.
        forceAwait:
          mode.type === "stale-revalidation" || (fullyPrefetched && !waited),
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
      const isSameStructureNav =
        mode.type === "navigate" && holdsAll(reconciled.segments);

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
      const cachedHandleData = readCachedHandleData?.();
      const { scroll: navScroll } = tx.commit(
        heldIds,
        reconciled.segments,
        overrides,
      );
      if (cachedHandleData) {
        store.updateCacheHandleData(store.getHistoryKey(), cachedHandleData);
      }
      const hasTransition = shouldStartViewTransition(
        reconciled.segments,
        gatedOff,
      );
      // After tx.commit(): the handle stream belongs to the entry it made.
      if (waited) config.fill?.handles(waited);

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

      const presentation =
        mode.type === "navigate" ? mode.presentation : undefined;
      const optimisticPresented = presentation !== undefined;
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
      const update: NavigationUpdate = {
        root: newTree,
        metadata: cachedHandleData
          ? { ...payload.metadata, cachedHandleData }
          : payload.metadata!,
        ...(navScroll && { scroll: navScroll }),
      };
      if (process.env.NODE_ENV !== "production") {
        auditTreeCause(treeCause(mode, tx.traversal));
      }
      if (
        !gatedOff &&
        (mode.type === "action" || mode.type === "stale-revalidation")
      ) {
        commitInTransition(
          store.loaders,
          onUpdate,
          reconciled.mainSegments,
          update,
          hasTransition ? ["action"] : [],
        );
      } else if (hasTransition) {
        commitInTransition(
          store.loaders,
          onUpdate,
          reconciled.mainSegments,
          update,
          optimisticPresented
            ? ["navigation", OPTIMISTIC_COMMIT_TRANSITION_TYPE]
            : ["navigation"],
        );
      } else if (
        !gatedOff &&
        ((fullyPrefetched && !holes) ||
          isSameStructureNav ||
          optimisticPresented)
      ) {
        // Content-hold commit, two triggers. Fully-prefetched nav: the payload
        // is fully resolved (forceAwait above), so the transition commits
        // synchronously — no fallback flash. Not a payload with holes: its
        // page is not whole, and a plain click to it commits urgently. In a
        // transition React starts a view transition for the commit wherever
        // a <ViewTransition> is mounted on the page being left, which the
        // plain click does not start, and what fills the holes is revealed
        // behind it (measured with a 600 ms view transition: the page
        // complete at 641 ms against 307). Same-structure nav: the re-run
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
          store.loaders,
          onUpdate,
          reconciled.mainSegments,
          update,
          optimisticPresented ? [OPTIMISTIC_COMMIT_TRANSITION_TYPE] : [],
        );
      } else {
        // Cold/partially-prefetched nav that mounts NEW segments, or any
        // commit transition({ when }) gated off (navigation, action refetch,
        // stale revalidation): normal, unanimated commit. A segment with work
        // still pending shows its loading() fallback like a first load; one
        // whose data is already in hand shows none. A gated-off segment keeps
        // its key, so a fallback comes from its boundary suspending on pending
        // work in this urgent commit, not from a remount (#995). Explicit
        // transition() routes keep the content-hold via the hasTransition
        // branch above (the opt-in).
        onUpdate(update);
      }
      // In a transition, so where React holds the tree the clear is held
      // with it (client-urls/navigation.ts).
      presentation?.clear();

      // The tree is committed and handed to React, which may hold it on a
      // hole read with no boundary: this navigation fills it now, from the
      // request that left before the render.
      if (holes) await fillHoles(holes, signal, url, gatedOff);

      debugLog("[Browser] Navigation complete");
      return;
    } else {
      console.warn(`[Browser] Full update (fallback)`);

      const segments = payload.metadata?.segments || [];
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

      if (process.env.NODE_ENV !== "production") {
        auditTreeCause(treeCause(mode, tx.traversal));
      }
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
        if (process.env.NODE_ENV !== "production") {
          auditTreeCause("stale-revalidation");
        }
        if (fullGatedOff) onUpdate(fullUpdate);
        else {
          commitInTransition(
            store.loaders,
            onUpdate,
            segments,
            fullUpdate,
            fullHasTransition ? ["action"] : [],
          );
        }
      } else if (mode.type === "action" && !fullGatedOff) {
        commitInTransition(
          store.loaders,
          onUpdate,
          segments,
          fullUpdate,
          fullHasTransition ? ["action"] : [],
        );
      } else if (fullHasTransition) {
        commitInTransition(store.loaders, onUpdate, segments, fullUpdate, [
          "navigation",
        ]);
      } else {
        onUpdate(fullUpdate);
      }

      return;
    }
  }

  return fetchPartialUpdate;
}

export { createPartialUpdater as default };
