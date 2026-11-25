"use client";

// SPIKE: <Outlet keep /> prototype. Throwaway: it answers claims B1-B9 of the
// kept-pages plan and is not meant to merge. Everything here is marked SPIKE.

import {
  Activity,
  createContext,
  createElement,
  isValidElement,
  startTransition,
  Suspense,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type Context,
  type ReactNode,
} from "react";
import { OutletContext, type OutletContextValue } from "./outlet-context.js";
import { OutletProvider } from "./outlet-provider.js";
import {
  OptimisticLocationContext,
  type OptimisticLocation,
} from "./client-urls/optimistic-location.js";
import { LocationStateContext } from "./browser/react/context.js";
import { stampLocationState } from "./browser/react/location-state-shared.js";
import { useParams } from "./browser/react/use-params.js";
import { usePathname } from "./browser/react/use-pathname.js";
import { useSearchParams } from "./browser/react/use-search-params.js";
import { ksSpike, SPIKE_KEPT_KEYS } from "./spike-kept-registry.js";

/** SPIKE: options of `<Outlet keep={...} />`. */
export interface OutletKeepOptions {
  /** How many left pages stay mounted and hidden, beside the one shown. */
  max: number;
  /**
   * A clientUrls() group's entry key: "params" (route id and params, the
   * default) or "route" (route id only, so a param change reconciles the
   * entry on screen as a group page does today). Server routes key by their
   * segment element's key whatever this says.
   */
  by?: "params" | "route";
  /**
   * SPIKE control for B1/B2: false draws a kept entry under the outlet's
   * live context instead of the one it was last drawn with.
   */
  isolate?: boolean;
  /**
   * SPIKE control for B6: false lets an entry shown again read its own
   * store subscriptions on its first render, as they were when it was hidden.
   */
  showLocation?: boolean;
}

/**
 * SPIKE: what a clientUrls() group's layouts render, provided by
 * ClientUrlsRoot: the route id and params of the page under the outlet (the
 * optimistic destination's on a frame).
 */
export interface KeepEntryIdentity {
  readonly route: string;
  readonly params: string;
}

export const KeepEntryContext: Context<KeepEntryIdentity | null> =
  createContext<KeepEntryIdentity | null>(null);

interface KeptEntry {
  readonly key: string;
  /** The outlet's context the entry was last drawn under. */
  readonly context: OutletContextValue | null;
  /** The location the entry was last drawn at. */
  readonly location: OptimisticLocation;
  /**
   * SPIKE (part E): the group page identity the entry was last drawn under.
   * A kept entry holding a nested keeping outlet must keep it: the live one
   * names the page on screen, and a hidden inner outlet reading it took that
   * for a switch of its own and mounted the shown page again, hidden.
   */
  readonly identity: KeepEntryIdentity | null;
  readonly content: ReactNode;
}

/**
 * SPIKE (part E): the location an outer keeping outlet hands the entry it
 * shows again, so a nested keeping outlet can tell it from a frame.
 */
const ShowLocationContext: Context<OptimisticLocation | null> =
  createContext<OptimisticLocation | null>(null);

/**
 * SPIKE (part E): set by a keeping outlet inside an entry of another one, so
 * the outer knows its entries hold a nested keeping outlet and leaves the
 * two-step reveal to it: staging the outer entry's kept element would draw
 * the inner outlet's last page, not the one navigated to.
 */
const NestedKeepContext: Context<{ current: boolean } | null> = createContext<{
  current: boolean;
} | null>(null);

/**
 * SPIKE (part E): in a clientUrls() group, the key of the group layout this
 * outlet renders, when its content is one (ClientUrlsRoot keys each layout
 * level's OutletProvider by `route.layoutKeys[i]`); null at the leaf, whose
 * content is the route component.
 */
function groupLayoutKey(content: ReactNode): string | null {
  return isValidElement(content) &&
    content.type === OutletProvider &&
    content.key != null
    ? content.key
    : null;
}

function entryKey(
  identity: KeepEntryIdentity | null,
  by: OutletKeepOptions["by"],
  content: ReactNode,
): string {
  // SPIKE (part E): an outer outlet in a group keys by the layout under it,
  // not by the page: KeepEntryContext names the page, so keying by it made
  // every page switch inside a section a switch of the outer's entries.
  const layoutKey = identity ? groupLayoutKey(content) : null;
  if (layoutKey !== null) return `layout:${layoutKey}`;
  if (identity) {
    return by === "route"
      ? `route:${identity.route}`
      : `route:${identity.route}|${identity.params}`;
  }
  // A server route's element carries its segment key (segment-system.tsx):
  // `id-params` outside a transition scope, `id` inside one. It can come
  // wrapped in unkeyed elements: a MountContextProvider for a route under
  // include() (`node.segment.mountPath`), a view-transition boundary under
  // transition() (wrapDefaultOutletContent). The key is the first keyed
  // element down the children.
  // SPIKE: found by the browser probe (part C); without it every route under
  // include() had the key "el:" and nothing was kept.
  let element = content;
  while (
    isValidElement<{ children?: ReactNode }>(element) &&
    element.key == null &&
    isValidElement(element.props.children)
  ) {
    element = element.props.children;
  }
  return isValidElement(element) && element.key != null
    ? `el:${element.key}`
    : "el:";
}

export function KeptOutlet({ keep }: { keep: OutletKeepOptions }): ReactNode {
  const context = useContext(OutletContext);
  const identity = useContext(KeepEntryContext);
  const optimistic = useContext(OptimisticLocationContext);
  // SPIKE (part E): an outer keeping outlet hands its shown entry the
  // current location on the render that shows it again (B6). That is no
  // frame: only a clientUrls() optimistic destination is.
  const outerShow = useContext(ShowLocationContext);
  const frame = optimistic !== null && optimistic !== outerShow;
  const params = useParams();
  const pathname = usePathname();
  const [search] = useSearchParams();
  const locationState = useContext(LocationStateContext);
  const content = context?.content ?? null;
  const key = entryKey(identity, keep.by, content);
  const isolate = keep.isolate !== false;

  // The left pages, last left last. Each is what the outlet drew for it in
  // its last commit.
  const [kept, setKept] = useState<readonly KeptEntry[]>([]);
  const [shownKey, setShownKey] = useState(key);
  // The entry on screen as React last committed it (written in a layout
  // effect, so a render React discards never lands here).
  const committed = useRef<KeptEntry | null>(null);
  // SPIKE (part E): false while an outer keeping outlet hides this one (its
  // layout effects are torn down), so the render that shows it again knows
  // its own entry on screen is coming back, though its key did not move.
  const onScreen = useRef(true);
  const nested = useRef(false);
  const parentNested = useContext(NestedKeepContext);
  useLayoutEffect(() => {
    if (parentNested) parentNested.current = true;
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  });
  // Reads refs in render: SPIKE.
  const returning =
    keep.showLocation !== false &&
    !onScreen.current &&
    committed.current !== null &&
    committed.current.key === key
      ? committed.current
      : null;
  // SPIKE (H3): the kept entry a committed navigation shows again, drawn with
  // its kept element and context in that commit; a transition then swaps in
  // the navigation's element.
  const [staged, setStaged] = useState<KeptEntry | null>(null);

  let entries = kept;
  if (returning && frame && !kept.some((entry) => entry.key === key)) {
    // SPIKE (part E): a frame shows this outlet again with the same entry on
    // screen. The entry joins the kept list until the frame commits, so
    // every render of the frame draws it with its last context (B3), not
    // the frame's pending loaders.
    entries = [...kept, returning];
    setKept(entries);
  } else if (shownKey !== key) {
    // SPIKE: adjusting state while rendering (the key moved): the entry
    // being left joins the kept list in this same render, so it never
    // unmounts between the two.
    // Reads the ref in render: SPIKE.
    const leaving = committed.current;
    entries = kept.filter((entry) => entry.key !== leaving?.key);
    if (leaving && leaving.key !== key) entries = [...entries, leaving];
    // The cap counts the left pages; the one being shown is not evicted.
    const shownIndex = entries.findIndex((entry) => entry.key === key);
    const evictable = entries.filter((_, index) => index !== shownIndex);
    while (evictable.length > keep.max) {
      const evicted = evictable.shift()!;
      entries = entries.filter((entry) => entry !== evicted);
    }
    setKept(entries);
    setShownKey(key);
    const back = entries.find((entry) => entry.key === key);
    setStaged(
      ksSpike()?.mode === "two-step" && back && !frame && !nested.current
        ? back
        : null,
    );
  } else if (
    returning &&
    ksSpike()?.mode === "two-step" &&
    !frame &&
    !nested.current &&
    staged?.key !== key
  ) {
    // SPIKE (part E): an outer outlet shows this one again with the same
    // entry on screen; the response may bring that entry a new element.
    setStaged(returning);
  }
  const stagedHere = staged?.key === key ? staged : null;

  const resumed =
    entries.find((entry) => entry.key === key) ?? returning ?? undefined;
  // B3: at an optimistic frame onto a kept entry, the entry shows the data
  // it was last drawn with, not the frame's pending route loaders. Once the
  // canonical commit brings its own context, the live one takes over.
  // SPIKE (part E): not at a group layout level. Its kept context holds the
  // layout element as last drawn, with the page that was on screen under it;
  // the frame's destination page is in the live context, and the leaf
  // outlet below swaps in that page's kept context.
  const shownContext =
    isolate && resumed && frame && groupLayoutKey(content) === null
      ? resumed.context
      : context;
  if (resumed && !frame && entries.includes(resumed)) {
    // Shown committed: the live context is the entry's now.
    entries = entries.filter((entry) => entry !== resumed);
    setKept(entries);
  }

  const location: OptimisticLocation = optimistic ?? {
    params: params as Record<string, string>,
    pathname,
    search: search.size ? `?${search.toString()}` : "",
    state: stampedState(locationState),
  };
  const shown: KeptEntry = stagedHere
    ? {
        key,
        context: stagedHere.context,
        location,
        identity,
        content: stagedHere.content,
      }
    : { key, context: shownContext, location, identity, content };

  // B6: the render that shows an entry again (the last commit had another
  // key on screen). Its hooks' own store reads are as old as its hide: their
  // subscriptions were off while hidden and catch up in a passive effect,
  // after a commit the browser can paint. On that render the entry reads
  // this outlet's location, which is current, instead.
  // Reads the ref in render: SPIKE.
  const showing =
    keep.showLocation !== false &&
    committed.current !== null &&
    (committed.current.key !== key ||
      // SPIKE (part E control): `__ksSpike.noReturnLocation` leaves an
      // outlet shown again by an outer one on its store hooks.
      (returning !== null && ksSpike()?.noReturnLocation !== true));

  useLayoutEffect(() => {
    committed.current = shown;
  });
  // SPIKE (part D): the hidden keys, for the commit probe in partial-update.
  useLayoutEffect(() => {
    const hidden = entries
      .filter((entry) => entry.key !== key)
      .map((entry) => entry.key);
    for (const k of hidden) SPIKE_KEPT_KEYS.add(k);
    return () => {
      for (const k of hidden) SPIKE_KEPT_KEYS.delete(k);
    };
  });
  useLayoutEffect(() => {
    if (!stagedHere) return;
    ksSpike()?.log.push({
      t: Math.round(performance.now()),
      outlet: "two-step: kept element committed, swap queued in a transition",
      key,
    });
    startTransition(() => setStaged(null));
  }, [stagedHere, key]);

  const shownLocation = optimistic ?? (showing ? location : null);
  const draw = (entry: KeptEntry, visible: boolean): ReactNode =>
    createElement(Activity, {
      key: entry.key,
      mode: visible ? "visible" : "hidden",
      children: createElement(OutletContext.Provider, {
        value: visible ? entry.context : isolate ? entry.context : context,
        children: createElement(OptimisticLocationContext.Provider, {
          // On screen and committed: null, so the hooks read the router
          // store as they do without keep.
          value: visible ? shownLocation : entry.location,
          children: createElement(ShowLocationContext.Provider, {
            // Not a frame: a hidden entry's own location, or the location
            // this outlet hands the entry it shows again.
            value: visible
              ? optimistic === null && showing
                ? location
                : outerShow
              : entry.location,
            children: createElement(KeepEntryContext.Provider, {
              value: visible ? identity : entry.identity,
              children: entry.content,
            }),
          }),
        }),
      }),
    });

  const nodes = [
    ...entries
      .filter((entry) => entry.key !== key)
      .map((entry) => draw(entry, false)),
    draw(shown, true),
  ];
  const tree = createElement(NestedKeepContext.Provider, {
    value: nested,
    children: nodes,
  });
  return context?.loading ? (
    <Suspense fallback={context.loading}>{tree}</Suspense>
  ) : (
    tree
  );
}

function stampedState(
  snapshot: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const state: Record<string, unknown> = { ...snapshot };
  stampLocationState(state);
  return state;
}
