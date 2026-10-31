"use client";

import { use, type ReactNode } from "react";
import { invalidateClientCache } from "@rangojs/router";
import {
  Link,
  useLinkStatus,
  useNavigation,
  useParams,
  usePathname,
  useSearchParams,
  useSegments,
} from "@rangojs/router/client";

/** How long a page the client has not seen yet holds its commit. */
const HOOK_FIELDS_HOLD = 900;

const pathOf = (url: string | null): string =>
  url === null ? "-" : new URL(url, "http://localhost").pathname;

/** A progress bar: isStreaming, through a selector. */
function HookFieldsBar(): ReactNode {
  const streaming = useNavigation((n) => n.isStreaming);
  return <p data-testid="hook-fields-bar" data-streaming={String(streaming)} />;
}

/** A pending label: pendingUrl, through a selector. */
function HookFieldsPending(): ReactNode {
  const pendingUrl = useNavigation((n) => n.pendingUrl);
  return (
    <p data-testid="hook-fields-pending" data-pending={pathOf(pendingUrl)} />
  );
}

/** A spinner: state, through a selector. */
function HookFieldsState(): ReactNode {
  const state = useNavigation((n) => n.state);
  return <p data-testid="hook-fields-state" data-state={state} />;
}

/** A dimmed page: isNavigating, through a selector. */
function HookFieldsNavigating(): ReactNode {
  const navigating = useNavigation((n) => n.isNavigating);
  return (
    <p
      data-testid="hook-fields-navigating"
      data-navigating={String(navigating)}
    />
  );
}

/** A breadcrumb: the location, through a selector. */
function HookFieldsLocation(): ReactNode {
  const pathname = useNavigation((n) => n.location.pathname);
  return <p data-testid="hook-fields-location" data-location={pathname} />;
}

/** A status line: the full state. */
function HookFieldsStatus(): ReactNode {
  const nav = useNavigation();
  return (
    <p
      data-testid="hook-fields-status"
      data-state={nav.state}
      data-navigating={String(nav.isNavigating)}
      data-streaming={String(nav.isStreaming)}
      data-pending={pathOf(nav.pendingUrl)}
      data-location={nav.location.pathname}
      data-search={nav.location.search}
    >
      {`${nav.state} ${nav.location.pathname}`}
    </p>
  );
}

/** A nav menu's active link: usePathname(). */
function HookFieldsPathname(): ReactNode {
  return <p data-testid="hook-fields-pathname" data-pathname={usePathname()} />;
}

/** A detail header: one param, through a selector. */
function HookFieldsParam(): ReactNode {
  const id = useParams((p) => p.id ?? "-");
  return <p data-testid="hook-fields-param" data-id={id} />;
}

/** A tab bar: useSearchParams(). */
function HookFieldsTab(): ReactNode {
  const [search] = useSearchParams();
  return (
    <p data-testid="hook-fields-tab" data-tab={search.get("tab") ?? "-"} />
  );
}

/** A breadcrumb: the path, through a useSegments() selector. */
function HookFieldsSegments(): ReactNode {
  const path = useSegments((s) => s.path.join("/"));
  return <p data-testid="hook-fields-segments" data-path={path} />;
}

/** A header that reads several URL hooks, the whole params map among them. */
function HookFieldsCrumb(): ReactNode {
  const pathname = usePathname();
  const { id } = useParams<{ id?: string }>();
  const [search] = useSearchParams();
  return (
    <p
      data-testid="hook-fields-crumb"
      data-crumb={`${pathname} ${id ?? "-"} ${search.get("tab") ?? "-"}`}
    />
  );
}

/** A link's spinner beside the stream, through a selector. */
function HookFieldsLinkChrome(): ReactNode {
  const { pending } = useLinkStatus();
  const streaming = useNavigation((n) => n.isStreaming);
  return (
    <span
      data-testid="hook-fields-link-chrome"
      data-link-pending={String(pending)}
      data-streaming={String(streaming)}
    />
  );
}

/** The chrome around /hook-fields/:id: every reader shape of the hook. */
export function HookFieldsChrome(): ReactNode {
  return (
    <header>
      <HookFieldsBar />
      <HookFieldsPending />
      <HookFieldsState />
      <HookFieldsNavigating />
      <HookFieldsLocation />
      <HookFieldsStatus />
      <HookFieldsPathname />
      <HookFieldsParam />
      <HookFieldsTab />
      <HookFieldsSegments />
      <HookFieldsCrumb />
      <nav>
        {["1", "2", "3", "4"].map((id) => (
          <Link
            key={id}
            to={`/hook-fields/${id}`}
            prefetch="none"
            data-testid={`hook-fields-link-${id}`}
          >
            {id}
            {id === "2" ? <HookFieldsLinkChrome /> : null}
          </Link>
        ))}
        <Link
          to="/hook-fields/2?tab=2"
          prefetch="none"
          data-testid="hook-fields-link-tab"
        >
          2, tab 2
        </Link>
        {/* The same URL with transition() gated off: its page commits
            urgently. */}
        <Link
          to="/hook-fields/2?tab=2"
          prefetch="none"
          transition={false}
          data-testid="hook-fields-link-urgent"
        >
          2, tab 2, now
        </Link>
      </nav>
      {/* Marks the history cache stale: Back restores, then revalidates. */}
      <button
        type="button"
        data-testid="hook-fields-invalidate"
        onClick={() => invalidateClientCache()}
      >
        invalidate
      </button>
    </header>
  );
}

// Module state of the fixture, not of a hook: the promise a stamp suspends
// on must be the same one on every render of it.
const holds = new Map<string, Promise<void> | null>();
let pendingHolds = 0;

/**
 * Suspends a stamp the client has not seen for HOOK_FIELDS_HOLD, so React
 * holds a commit that brings one. The document's stamp does not hold. While
 * any hold is pending, <html data-hook-fields-holding> counts them, for the
 * suite to see that React held a page.
 */
export function HookFieldsHold({ stamp }: { stamp: string }): ReactNode {
  if (typeof window !== "undefined") {
    if (!holds.has(stamp)) {
      holds.set(
        stamp,
        holds.size === 0
          ? null
          : new Promise((resolve) => {
              const root = document.documentElement.dataset;
              root.hookFieldsHolding = String(++pendingHolds);
              setTimeout(() => {
                root.hookFieldsHolding = String(--pendingHolds);
                resolve();
              }, HOOK_FIELDS_HOLD);
            }),
      );
    }
    const hold = holds.get(stamp);
    if (hold) use(hold);
  }
  return <p data-testid="hook-fields-stamp" data-stamp={stamp} />;
}
