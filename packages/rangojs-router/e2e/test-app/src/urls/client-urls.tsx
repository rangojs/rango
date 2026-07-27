"use client";

import { Suspense, useState } from "react";
import {
  clientUrls,
  ErrorBoundary,
  Link,
  useAction,
  useFetchLoader,
  useHref,
  useLinkStatus,
  useLoader,
  useLocationState,
  useMount,
  useNavigation,
  useOutlet,
  useParams,
  usePathname,
  useRefreshLoaders,
  useRouter,
  useSearchParams,
} from "@rangojs/router/client";
import {
  bumpClientUrlsCounter,
  cuSaveAndRedirect,
  setCuNote,
} from "../actions.jsx";
import { CuFlash, CuNote } from "../location-states.js";
import {
  ClientUrlsItemLoader,
  ClientUrlsLegacyRedirectLoader,
  ClientUrlsPulseLoader,
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

/** Group-tagged read behind its own boundary: useRefreshLoaders("probe")
 *  re-runs it with a plain refresh GET — deliberately outside the
 *  revalidate() decision protocol (an explicit refresh wants freshness). */
function HooksPulse() {
  const { data } = useLoader(ClientUrlsPulseLoader, { refreshGroup: "probe" });
  return <div data-testid="cu-hooks-pulse">{data}</div>;
}

/**
 * Hook coverage probe for the group model: every navigation/url/status hook a
 * group component can legally call, echoed into testids. Pins the semantics
 * the docs promise — useMount is the include mount, usePathname is ABSOLUTE
 * (mount included), useSearchParams carries the live request's search during
 * SSR and its setter is a same-route write, useNavigation/useLinkStatus
 * report the canonical nav in-flight, useFetchLoader/useRefreshLoaders are
 * refresh lanes outside the revalidate() protocol, useAction tracks a group
 * action's lifecycle, relative router.push resolves against the mount, and
 * a plain React ErrorBoundary is the in-group error affordance.
 */
function ClientUrlsHooksProbe() {
  const mount = useMount();
  const pathname = usePathname();
  const [searchParams, setSearchParams] = useSearchParams();
  const navState = useNavigation((nav) => nav.state);
  const groupHref = useHref();
  const stamp = useFetchLoader(ClientUrlsStampLoader);
  const refresh = useRefreshLoaders();
  const bump = useAction(bumpClientUrlsCounter);
  const router = useRouter();

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
      <div data-testid="cu-hooks-action-state">action:{bump.state}</div>
      <Suspense fallback={<div data-testid="cu-hooks-pulse">pulse:…</div>}>
        <HooksPulse />
      </Suspense>

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
      <button
        data-testid="cu-hooks-refresh-pulse"
        onClick={() => void refresh("probe")}
      >
        Refresh pulse
      </button>
      <button
        data-testid="cu-hooks-run-action"
        onClick={() => void bumpClientUrlsCounter()}
      >
        Run action
      </button>
      {/* RELATIVE path: no leading slash — resolves against the include
          mount (absolute paths stay app-absolute, unchanged). */}
      <button
        data-testid="cu-hooks-rel-push"
        onClick={() => void router.push("items/rel-nav")}
      >
        Relative push
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

/**
 * Location-state probe for the group write lanes. Groups have no handlers, so
 * the server write surface is exactly: action in-place writes (merge on
 * settle) and redirect()-carried state (action and loader redirects). The
 * readers render "none" placeholders so a delivery is observable as a change.
 */
function ClientUrlsStateProbe() {
  const flash = useLocationState(CuFlash);
  const note = useLocationState(CuNote);

  return (
    <section data-testid="cu-state">
      <div data-testid="cu-state-flash">
        {flash ? `flash:${flash.text}` : "flash:none"}
      </div>
      <div data-testid="cu-state-note">
        {note ? `note:${note.value}` : "note:none"}
      </div>
      <button
        data-testid="cu-state-set-note"
        onClick={() => void setCuNote("from-action")}
      >
        Set note
      </button>
      <button
        data-testid="cu-state-action-redirect"
        onClick={() => void cuSaveAndRedirect()}
      >
        Save and redirect
      </button>
      {/* prefetch="none": a warmed prefetch would run the redirect-throwing
          loader ahead of the click and decouple the click from the request
          under test (production defaults to viewport prefetch). */}
      <Link
        to="/client-urls-e2e/legacy"
        prefetch="none"
        data-testid="cu-state-legacy-link"
      >
        Open legacy
      </Link>
    </section>
  );
}

function ClientUrlsLegacy() {
  // Never renders with data — the loader always redirects. The read keeps
  // the route on the streaming read-site path so the thrown redirect
  // surfaces through the loader boundary rather than being ignored.
  useLoader(ClientUrlsLegacyRedirectLoader);
  return <div data-testid="cu-legacy">legacy</div>;
}

export default clientUrls(({ layout, path, loader, loading }) => [
  layout(ClientUrlsLayout, () => [
    path("/", ClientUrlsIndex),
    path("/hooks", ClientUrlsHooksProbe, () => [loader(ClientUrlsPulseLoader)]),
    path("/state", ClientUrlsStateProbe),
    path("/legacy", ClientUrlsLegacy, () => [
      loader(ClientUrlsLegacyRedirectLoader),
      loading(<div data-testid="cu-legacy-loading">Loading legacy</div>),
    ]),
    path("/items/:itemId", ClientUrlsItem, () => [
      loader(ClientUrlsItemLoader),
      loading(<ClientUrlsItemLoading />),
    ]),
  ]),
]);
