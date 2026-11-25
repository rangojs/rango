"use client";

import {
  Activity,
  createElement,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FragmentInstance,
  type ReactNode,
  type RefObject,
} from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import {
  OptimisticLocationContext,
  type OptimisticLocation,
} from "./client-urls/optimistic-location.js";
import { findLoaderRead } from "./use-loader.js";
import { INTERNAL_RANGO_SUSPENSE_AUDIT } from "./internal-suspense-audit.js";
import { AuditScope } from "./suspense-audit-react.js";
import {
  LocationStateContext,
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "./browser/react/context.js";
import { shownLocationState } from "./browser/history-state.js";
import { useNavigation } from "./browser/react/use-navigation.js";
import { useParams } from "./browser/react/use-params.js";
import { usePathname } from "./browser/react/use-pathname.js";
import { useSearchParams } from "./browser/react/use-search-params.js";
import {
  useSegments,
  type SegmentsState,
} from "./browser/react/use-segments.js";
import type { PublicNavigationState } from "./browser/types.js";
import {
  KeptEntryContext,
  type KeptEntryState,
  type OutletKeepOptions,
} from "./outlet-keep-context.js";

/** An entry's location: its URL, and the segments useSegments reads there. */
type KeptLocation = OptimisticLocation & { readonly segments: SegmentsState };

/** One page a keeping outlet draws, as it last drew it. */
interface Entry {
  readonly key: string;
  readonly content: ReactNode;
  /**
   * The outlet context the entry's loader reads belong to. A hidden entry is
   * drawn under it: in a clientUrls() group the page's own loader data lives
   * above the group's layouts, in the context the next page replaced.
   */
  readonly context: OutletContextValue | null;
  /** Hidden: also the idle navigation state its useNavigation reads. */
  readonly location: KeptLocation;
  readonly shows: number;
  /**
   * Drawn on a clientUrls() frame that has not committed: a page the person
   * has not landed on yet. Left before its commit (a newer click, an abort),
   * it is dropped, not kept.
   */
  readonly provisional: boolean;
}

interface KeepState {
  readonly shown: Entry;
  /** Hidden entries in key order, the order every entry draws in. */
  readonly hidden: readonly Entry[];
  /** The hidden entries' keys, the one left longest ago first. */
  readonly left: readonly string[];
  /**
   * How the shown entry came back from hidden, until that settles. "frame": on
   * a clientUrls() frame, its own context answers the frame's waiting reads
   * until the frame commits. "handoff": outside a frame, its own URL and
   * navigation subscriptions were off while hidden and catch up in a passive
   * effect, so until then it reads the outlet's, which stayed live.
   */
  readonly comeback: "frame" | "handoff" | null;
}

type Kept = Pick<KeepState, "hidden" | "left">;

/** `hidden` with `entry` at its key's place. */
function withHidden(hidden: readonly Entry[], entry: Entry): Entry[] {
  const next = hidden.slice();
  const index = next.findIndex((other) => other.key > entry.key);
  next.splice(index === -1 ? next.length : index, 0, entry);
  return next;
}

/** At most `max` hidden entries; the ones left longest ago go first. */
function capped(kept: Kept, max: number): Kept {
  if (kept.left.length <= max) return kept;
  const evicted = kept.left.slice(0, kept.left.length - max);
  return {
    hidden: kept.hidden.filter((entry) => !evicted.includes(entry.key)),
    left: kept.left.slice(kept.left.length - max),
  };
}

/** `max` when it is a whole number 0 or more, or Infinity; else 0, reported once. */
function resolveMax(max: unknown, reported: { current: boolean }): number {
  if (
    typeof max === "number" &&
    max >= 0 &&
    (Number.isInteger(max) || max === Infinity)
  ) {
    return max;
  }
  if (process.env.NODE_ENV !== "production" && !reported.current) {
    reported.current = true;
    console.error(
      `[rango] <Outlet keep={{ max: ${String(max)} }} />: max is how many left pages stay hidden, a whole number 0 or more, or Infinity. Keeping none.`,
    );
  }
  return 0;
}

/**
 * `live` with the reads a clientUrls() frame leaves waiting for its commit
 * (OutletContextValue.awaitingCommit: the destination's own loaders) answered
 * from the entry's own context. Every other read, a parent layout's included,
 * stays live.
 */
function answerAwaitedReads(
  own: OutletContextValue | null,
  live: OutletContextValue | null,
): OutletContextValue | null {
  if (!own || !live) return live;
  let loaderData: Record<string, unknown> | undefined;
  let loaderStreams: Record<string, unknown> | undefined;
  for (let level: OutletContextValue | null | undefined = live; level; ) {
    for (const id of level.awaitingCommit ?? []) {
      const read = findLoaderRead(own, id);
      if (!read) continue;
      if ("value" in read) (loaderData ??= {})[id] ??= read.value;
      else (loaderStreams ??= {})[id] ??= read.stream;
    }
    level = level.parent;
  }
  if (!loaderData && !loaderStreams) return live;
  return {
    ...live,
    loaderData: loaderData
      ? { ...live.loaderData, ...loaderData }
      : live.loaderData,
    loaderStreams: loaderStreams
      ? { ...live.loaderStreams, ...loaderStreams }
      : live.loaderStreams,
  };
}

/** The idle navigation state at the entry's own URL. */
function idleAt(location: KeptLocation): PublicNavigationState {
  return {
    state: "idle",
    isStreaming: false,
    isNavigating: false,
    pendingUrl: null,
    location: new URL(
      location.pathname + location.search,
      location.segments.location,
    ),
  };
}

/**
 * The router store as the entry's pages reach it: its navigate does nothing
 * while the entry is hidden, read at call time (an event or a late promise in
 * a hidden page), so the search-params setter, useRouter() and `<Link>`
 * navigate nowhere from there. The prototype keeps the store's live getters
 * (basename, version).
 */
function inertWhileHidden(
  store: NavigationStoreContextValue,
  isHidden: () => boolean,
): NavigationStoreContextValue {
  const navigate: NavigationStoreContextValue["navigate"] = (url, options) => {
    if (!isHidden()) return store.navigate(url, options);
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[rango] A page hidden by <Outlet keep /> navigated to "${url}". It does nothing while the page is hidden.`,
      );
    }
    return Promise.resolve();
  };
  return Object.create(store, { navigate: { value: navigate } });
}

/**
 * A page shown again goes from `display: none` to shown, which replays its
 * `@starting-style` entrances. Its transitions are finished in the commit
 * that shows it: getAnimations() applies the pending style first, so the
 * transitions the show starts are there to finish. A Fragment ref's
 * observeUsing hands its observer each top-level DOM node of the fragment;
 * any object with `observe` takes the observer's place.
 */
function finishEntrances(fragment: FragmentInstance | null): void {
  if (
    !fragment ||
    typeof fragment.observeUsing !== "function" ||
    typeof CSSTransition === "undefined"
  ) {
    return;
  }
  const nodes: Element[] = [];
  const collect = {
    observe: (node: Element) => {
      nodes.push(node);
    },
    unobserve: () => {},
  } as unknown as ResizeObserver;
  fragment.observeUsing(collect);
  fragment.unobserveUsing(collect);
  for (const node of nodes) {
    if (typeof node.getAnimations !== "function") continue;
    for (const animation of node.getAnimations({ subtree: true })) {
      if (animation instanceof CSSTransition) animation.finish();
    }
  }
}

interface KeptEntryViewProps {
  readonly entryKey: string;
  readonly hidden: boolean;
  readonly shows: number;
  /** The location the entry's hooks read; null passes the one above through. */
  readonly location: OptimisticLocation | null;
  readonly returning: boolean;
  readonly context: OutletContextValue | null;
  readonly outerIsHidden: (() => boolean) | undefined;
  readonly shownKey: RefObject<string>;
  readonly outlet: KeptEntryState["outlet"];
  readonly children: ReactNode;
}

const KeptEntryView = memo(function KeptEntryView({
  entryKey,
  hidden,
  shows,
  location,
  returning,
  context,
  outerIsHidden,
  shownKey,
  outlet,
  children,
}: KeptEntryViewProps): ReactNode {
  const isHidden = useCallback(
    () => shownKey.current !== entryKey || (outerIsHidden?.() ?? false),
    [shownKey, entryKey, outerIsHidden],
  );
  const value = useMemo<KeptEntryState>(
    () => ({ hidden, shows, returning, isHidden, outlet }),
    [hidden, shows, returning, isHidden, outlet],
  );
  const store = useContext(NavigationStoreContext);
  const entryStore = useMemo(
    () => store && inertWhileHidden(store, isHidden),
    [store, isHidden],
  );
  // A Fragment ref: React 19.3 has them, an older React leaves it null.
  const fragment = useRef<FragmentInstance | null>(null);
  // Runs on every show: a hidden Activity's effects are torn down and run
  // again when it shows. Not on the first mount.
  useLayoutEffect(() => {
    if (shows > 0) finishEntrances(fragment.current);
  }, [shows]);
  return createElement(OutletContext.Provider, {
    value: context,
    children: createElement(OptimisticLocationContext.Provider, {
      value: location,
      children: createElement(NavigationStoreContext.Provider, {
        value: entryStore,
        children: createElement(KeptEntryContext.Provider, {
          value,
          children: createElement(Fragment, {
            ref: fragment,
            children:
              process.env.NODE_ENV !== "production" &&
              INTERNAL_RANGO_SUSPENSE_AUDIT
                ? createElement(AuditScope, {
                    scope: `kept ${entryKey}`,
                    children,
                  })
                : children,
          }),
        }),
      }),
    }),
  });
});

/**
 * `<Outlet keep />`: the outlet's pages, each in its own `<Activity>`, the one
 * on screen visible and up to `keep.max` it left hidden. Its first render
 * draws the shown page alone in a visible Activity, whatever `keep` says, so
 * the server's render and hydration agree.
 */
export function KeptOutlet({ keep }: { keep: OutletKeepOptions }): ReactNode {
  const context = useContext(OutletContext);
  const optimistic = useContext(OptimisticLocationContext);
  const outer = useContext(KeptEntryContext);
  const locationState = useContext(LocationStateContext);
  const params = useParams() as Readonly<Record<string, string>>;
  const pathname = usePathname();
  const [search] = useSearchParams();
  const segments = useSegments();
  const content = context?.content ?? null;
  const draws = context?.draws;

  // A clientUrls() frame draws an optimistic destination.
  const frame = optimistic?.kind === "frame";
  const searchString = search.toString();
  const location = useMemo<KeptLocation>(
    () => ({
      kind: "kept",
      params,
      pathname,
      search: searchString ? `?${searchString}` : "",
      state: shownLocationState(locationState),
      segments,
    }),
    [params, pathname, searchString, locationState, segments],
  );

  const key = keep.key
    ? keep.key({ route: draws?.route ?? "", params, search })
    : (draws?.key ?? "");
  const reported = useRef(false);
  const max = resolveMax(keep.max, reported);

  const [state, setState] = useState<KeepState>(() => ({
    shown: {
      key,
      content,
      context,
      location,
      shows: 0,
      provisional: false,
    },
    hidden: [],
    left: [],
    comeback: null,
  }));
  // Read only on the render that shows a hidden entry again, so nothing
  // re-renders the outlet on a navigation while it hides none.
  const navigation = useNavigation((nav) =>
    state.hidden.length > 0 ? nav : null,
  );

  // An outer keeping outlet shows this one again on a frame, with this
  // outlet's own entry unchanged.
  const outerReturning = (outer?.returning ?? false) && state.shown.key === key;
  // The shown entry reads its own context on a frame: back from hidden here,
  // or drawn back by an outer keeping outlet.
  const ownReads = (comeback: KeepState["comeback"]): boolean =>
    frame && (comeback === "frame" || outerReturning);

  let next = state;
  if (state.shown.key !== key) {
    const back = state.hidden.find((entry) => entry.key === key);
    let kept: Kept = back
      ? {
          hidden: state.hidden.filter((entry) => entry !== back),
          left: state.left.filter((left) => left !== key),
        }
      : state;
    if (!state.shown.provisional) {
      const at = state.shown.location;
      kept = {
        hidden: withHidden(kept.hidden, {
          ...state.shown,
          location: { ...at, navigation: idleAt(at) },
        }),
        left: [...kept.left, state.shown.key],
      };
    }
    const { hidden, left } = capped(kept, max);
    next = {
      shown: {
        key,
        content,
        context: back && frame ? back.context : context,
        location,
        shows: back ? back.shows + 1 : 0,
        provisional: frame && back === undefined,
      },
      hidden,
      left,
      comeback: back === undefined ? null : frame ? "frame" : "handoff",
    };
  } else {
    const comeback =
      state.comeback === "frame" && !frame ? null : state.comeback;
    const ownContext = ownReads(comeback) ? state.shown.context : context;
    const provisional = state.shown.provisional && frame;
    // A lower max takes effect at once.
    const kept = capped(state, max);
    if (
      state.shown.content !== content ||
      state.shown.context !== ownContext ||
      state.shown.location !== location ||
      state.shown.provisional !== provisional ||
      state.comeback !== comeback ||
      state.hidden !== kept.hidden
    ) {
      next = {
        shown: {
          ...state.shown,
          content,
          context: ownContext,
          location,
          provisional,
        },
        hidden: kept.hidden,
        left: kept.left,
        comeback,
      };
    }
  }
  if (next !== state) setState(next);

  const returning = ownReads(next.comeback);
  // A clientUrls() group layout level's kept context holds the page under
  // it: the keeping outlet nearest the page answers the frame's reads.
  const answering = returning && draws?.kind !== "group-layout";
  const shownContext = useMemo(
    () =>
      answering ? answerAwaitedReads(next.shown.context, context) : context,
    [answering, next.shown.context, context],
  );

  const shownKey = useRef(next.shown.key);
  useLayoutEffect(() => {
    shownKey.current = state.shown.key;
  }, [state.shown.key]);

  // After the show's commit: the shown entry's own subscriptions ran their
  // catch-up in its passive effects, which run before this one, so both
  // updates land in one render with equal values.
  useEffect(() => {
    if (state.comeback === "handoff") {
      setState((current) =>
        current.comeback === "handoff"
          ? { ...current, comeback: null }
          : current,
      );
    }
  }, [state.comeback]);

  const [outlet] = useState<KeptEntryState["outlet"]>(() => ({
    drop: (dropKey) => {
      if (dropKey === shownKey.current) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            `[rango] useKeptOutlet().drop("${dropKey}"): that entry is on screen; only a hidden entry is dropped.`,
          );
        }
        return;
      }
      setState((current) =>
        current.left.includes(dropKey)
          ? {
              ...current,
              hidden: current.hidden.filter((entry) => entry.key !== dropKey),
              left: current.left.filter((left) => left !== dropKey),
            }
          : current,
      );
    },
  }));

  // On the render that shows a hidden entry outside a frame, its hooks read
  // the outlet's location and navigation until their own catch up.
  const handing = next.comeback === "handoff";
  const handoff = useMemo<OptimisticLocation | null>(
    () =>
      handing
        ? { ...location, navigation: navigation ?? idleAt(location) }
        : null,
    [handing, location, navigation],
  );

  const outerShows = outer?.shows ?? 0;
  const outerIsHidden = outer?.isHidden;
  const shown = createElement(Activity, {
    key: next.shown.key,
    mode: "visible",
    children: createElement(KeptEntryView, {
      entryKey: next.shown.key,
      hidden: outer?.hidden ?? false,
      shows: next.shown.shows + outerShows,
      location: handoff ?? optimistic,
      returning,
      context: shownContext,
      outerIsHidden,
      shownKey,
      outlet,
      children: content,
    }),
  });
  // Inside the Outlet's own fallback and loading() boundaries (client.tsx).
  const entries: ReactNode[] = [];
  let placed = false;
  for (const entry of next.hidden) {
    if (!placed && next.shown.key < entry.key) {
      entries.push(shown);
      placed = true;
    }
    entries.push(
      createElement(Activity, {
        key: entry.key,
        mode: "hidden",
        children: createElement(KeptEntryView, {
          entryKey: entry.key,
          hidden: true,
          shows: entry.shows + outerShows,
          location: entry.location,
          returning: false,
          context: entry.context,
          outerIsHidden,
          shownKey,
          outlet,
          children: entry.content,
        }),
      }),
    );
  }
  if (!placed) entries.push(shown);
  return entries;
}
