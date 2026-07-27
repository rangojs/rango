"use client";

import { useState } from "react";
import {
  clientUrls,
  ErrorBoundary,
  Link,
  useFetchLoader,
  useHref,
  useLinkStatus,
  useLoader,
  useMount,
  useNavigation,
  useOutlet,
  useParams,
  usePathname,
  useSearchParams,
} from "@rangojs/router/client";
import {
  ClientUrlsItemLoader,
  ClientUrlsStampLoader,
} from "./client-urls.loader.js";

function ClientUrlsLayout() {
  const { content, pending } = useOutlet();

  return (
    <main data-testid="client-urls-layout" data-pending={String(pending)}>
      <h1>Client URLs</h1>
      {content}
    </main>
  );
}

function ClientUrlsIndex() {
  return (
    <section data-testid="client-urls-index">
      <Link
        to="/client-urls-e2e/items/soft-nav"
        prefetch="none"
        data-testid="client-urls-item-link"
      >
        Open item
      </Link>
    </section>
  );
}

function ClientUrlsItem() {
  const { data } = useLoader(ClientUrlsItemLoader);
  const params = useParams();

  return (
    <article data-testid="client-urls-item">
      <div data-testid="client-urls-item-param">{params.itemId}</div>
      <div data-testid="client-urls-item-loader">{data}</div>
      <Link
        to="/client-urls-e2e"
        prefetch="none"
        data-testid="client-urls-index-link"
      >
        Back to index
      </Link>
    </article>
  );
}

function ClientUrlsItemLoading() {
  return <div data-testid="client-urls-item-loading">Loading item</div>;
}

/** Child of a Link: useLinkStatus reads the surrounding LinkContext. */
function HooksLinkBadge() {
  const { pending } = useLinkStatus();
  return <span data-testid="cu-hooks-link-status">{String(pending)}</span>;
}

function HooksBoom() {
  const [boom, setBoom] = useState(false);
  if (boom) throw new Error("client-urls hooks probe boom");
  return (
    <button data-testid="cu-hooks-boom" onClick={() => setBoom(true)}>
      boom
    </button>
  );
}

/**
 * Hook coverage probe for the group model: every navigation/url/status hook a
 * group component can legally call, echoed into testids. Pins the semantics
 * the docs promise — useMount is the include mount, usePathname is ABSOLUTE
 * (mount included), useSearchParams is SSR-empty and its setter is a
 * same-route write, useNavigation/useLinkStatus report the canonical nav
 * in-flight, useFetchLoader is route-independent, and a plain React
 * ErrorBoundary is the in-group error affordance.
 */
function ClientUrlsHooksProbe() {
  const mount = useMount();
  const pathname = usePathname();
  const [searchParams, setSearchParams] = useSearchParams();
  const navState = useNavigation((nav) => nav.state);
  const groupHref = useHref();
  const stamp = useFetchLoader(ClientUrlsStampLoader);

  return (
    <section data-testid="cu-hooks">
      <div data-testid="cu-hooks-mount">mount:{mount}</div>
      <div data-testid="cu-hooks-pathname">pathname:{pathname}</div>
      {/* Single template child: adjacent JSX text expressions SSR with
          <!-- --> separators and the e2e asserts this string in RAW HTML. */}
      <div data-testid="cu-hooks-flavor">
        {`flavor:${searchParams.get("flavor") ?? "none"}`}
      </div>
      <div data-testid="cu-hooks-nav-state">nav:{navState}</div>
      <div data-testid="cu-hooks-stamp">{stamp.data ?? "stamp:none"}</div>

      <button
        data-testid="cu-hooks-set-flavor"
        onClick={() => void setSearchParams({ flavor: "mint" })}
      >
        Set flavor
      </button>
      <button
        data-testid="cu-hooks-fetch-stamp"
        onClick={() => void stamp.load({})}
      >
        Fetch stamp
      </button>

      {/* useHref composes the include mount: this href must resolve to
          <mount>/items/href-nav wherever the group is mounted. */}
      <Link
        to={groupHref("/items/href-nav")}
        prefetch="none"
        data-testid="cu-hooks-href-link"
      >
        Open item via useHref
      </Link>

      {/* Status probe target: the INDEX has no loading(), so the optimistic
          layer keeps THIS route rendered during the nav — the badge below
          survives to report pending. (A destination WITH loading() swaps the
          probe out optimistically and unmounts any in-link reader.) */}
      <Link
        to={groupHref("/")}
        prefetch="none"
        data-testid="cu-hooks-status-link"
      >
        Back to index
        <HooksLinkBadge />
      </Link>

      <ErrorBoundary
        fallback={
          <div data-testid="cu-hooks-error-fallback">probe crashed</div>
        }
      >
        <HooksBoom />
      </ErrorBoundary>
    </section>
  );
}

export default clientUrls(({ layout, path, loader, loading }) => [
  layout(ClientUrlsLayout, () => [
    path("/", ClientUrlsIndex),
    path("/hooks", ClientUrlsHooksProbe),
    path("/items/:itemId", ClientUrlsItem, () => [
      loader(ClientUrlsItemLoader),
      loading(<ClientUrlsItemLoading />),
    ]),
  ]),
]);
