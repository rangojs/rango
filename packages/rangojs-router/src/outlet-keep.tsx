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
  /**
   * SPIKE (demo): "two-step" shows a kept server-route entry with its kept
   * element first and swaps in the navigation's element in a transition, as
   * `__ksSpike.mode = "two-step"` does for every outlet (part D, H3).
   */
  reveal?: "two-step";
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
  readonly content: ReactNode;
}

function entryKey(
  identity: KeepEntryIdentity | null,
  by: OutletKeepOptions["by"],
  content: ReactNode,
): string {
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
  // SPIKE (H3): the kept entry a committed navigation shows again, drawn with
  // its kept element and context in that commit; a transition then swaps in
  // the navigation's element.
  const [staged, setStaged] = useState<KeptEntry | null>(null);

  let entries = kept;
  if (shownKey !== key) {
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
      (keep.reveal === "two-step" || ksSpike()?.mode === "two-step") &&
        back &&
        !optimistic
        ? back
        : null,
    );
  }
  const stagedHere = staged?.key === key ? staged : null;

  const resumed = entries.find((entry) => entry.key === key);
  // B3: at an optimistic frame onto a kept entry, the entry shows the data
  // it was last drawn with, not the frame's pending route loaders. Once the
  // canonical commit brings its own context, the live one takes over.
  const shownContext =
    isolate && resumed && optimistic ? resumed.context : context;
  if (resumed && !optimistic) {
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
        content: stagedHere.content,
      }
    : { key, context: shownContext, location, content };

  // B6: the render that shows an entry again (the last commit had another
  // key on screen). Its hooks' own store reads are as old as its hide: their
  // subscriptions were off while hidden and catch up in a passive effect,
  // after a commit the browser can paint. On that render the entry reads
  // this outlet's location, which is current, instead.
  // Reads the ref in render: SPIKE.
  const showing =
    keep.showLocation !== false &&
    committed.current !== null &&
    committed.current.key !== key;

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

  const draw = (entry: KeptEntry, visible: boolean): ReactNode =>
    createElement(Activity, {
      key: entry.key,
      mode: visible ? "visible" : "hidden",
      children: createElement(OutletContext.Provider, {
        value: visible ? entry.context : isolate ? entry.context : context,
        children: createElement(OptimisticLocationContext.Provider, {
          // On screen and committed: null, so the hooks read the router
          // store as they do without keep.
          value: visible
            ? (optimistic ?? (showing ? location : null))
            : entry.location,
          children: entry.content,
        }),
      }),
    });

  const nodes = [
    ...entries
      .filter((entry) => entry.key !== key)
      .map((entry) => draw(entry, false)),
    draw(shown, true),
  ];
  return context?.loading ? (
    <Suspense fallback={context.loading}>{nodes}</Suspense>
  ) : (
    nodes
  );
}

function stampedState(
  snapshot: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const state: Record<string, unknown> = { ...snapshot };
  stampLocationState(state);
  return state;
}
