"use client";

import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
} from "@rangojs/router/client";
import { bumpClientUrlsCounter } from "../actions.jsx";
import * as ClientUrlsIsActions from "./client-urls-is-action.actions.js";
import {
  clientUrlsDecoyAction,
  clientUrlsTargetAction,
} from "./client-urls-is-action.actions.js";
import {
  clientUrlsResultAction,
  clientUrlsScopeAction,
} from "./client-urls-result.actions.js";
import {
  ClientUrlsAlwaysLoader,
  ClientUrlsCounterLoader,
  ClientUrlsIsActionNsLoader,
  ClientUrlsIsActionTargetLoader,
  ClientUrlsItemLoader,
  ClientUrlsResultLoader,
  ClientUrlsScopedLoader,
  ClientUrlsSessionLoader,
} from "./client-urls.loader.js";

/**
 * clientUrls() group pinning ACTION revalidation semantics. Loaders are
 * declared at the client LAYOUT level, so they reach the route record via the
 * DSL's flatten (the group's loaders are the route's server-side material).
 * After the server action bumps the shared counter, the follow-up render:
 * - revalidates ClientUrlsCounterLoader (locked default: true on actions);
 * - SKIPS ClientUrlsSessionLoader — its revalidate() below, which the build
 *   moves to the server, opts out of action revalidation;
 * - keeps the parent RSC layout in urls.tsx (reads the SAME counter) on the
 *   locked parent-chain skip.
 * Three freshness outcomes from one counter in one commit.
 *
 * The index route's result and scoped loaders pin what only a server-run
 * predicate can see: the action's result and its form data. Its always
 * loader (revalidate(true)) re-runs on a same-URL navigation, where the
 * default holds the result loader and revalidate(false) the session loader.
 */

function ActionClientLayout() {
  const { content } = useOutlet();

  return (
    <section data-testid="ca-layout">
      <h2>ClientUrls action group</h2>
      {content}
    </section>
  );
}

function ActionClientIndex() {
  const { data } = useLoader(ClientUrlsCounterLoader);
  const { data: session } = useLoader(ClientUrlsSessionLoader);
  const { data: target } = useLoader(ClientUrlsIsActionTargetLoader);
  const { data: ns } = useLoader(ClientUrlsIsActionNsLoader);
  const { data: result } = useLoader(ClientUrlsResultLoader);
  const { data: scoped } = useLoader(ClientUrlsScopedLoader);
  const { data: always } = useLoader(ClientUrlsAlwaysLoader);

  return (
    <div data-testid="ca-index">
      <span data-testid="ca-loader">{data}</span>
      <span data-testid="ca-session">{session}</span>
      <span data-testid="ca-is-action-target-runs">{target.runs}</span>
      <span data-testid="ca-is-action-ns-runs">{ns.runs}</span>
      <span data-testid="ca-result-runs">{result.runs}</span>
      <span data-testid="ca-scoped-runs">{scoped.runs}</span>
      <span data-testid="ca-always-runs">{always.runs}</span>
      <Link to="/client-urls-action" prefetch="none" data-testid="ca-self">
        This page
      </Link>
      <button
        data-testid="ca-bump"
        onClick={() => void bumpClientUrlsCounter()}
      >
        Bump counter
      </button>
      <button
        data-testid="ca-is-action-target"
        onClick={() => void clientUrlsTargetAction()}
      >
        Target action
      </button>
      <button
        data-testid="ca-is-action-decoy"
        onClick={() => void clientUrlsDecoyAction()}
      >
        Decoy action
      </button>
      <button
        data-testid="ca-result-ok"
        onClick={() => void clientUrlsResultAction(true)}
      >
        Action that succeeds
      </button>
      <button
        data-testid="ca-result-fail"
        onClick={() => void clientUrlsResultAction(false)}
      >
        Action that fails
      </button>
      <form action={clientUrlsScopeAction}>
        <input type="hidden" name="scope" value="all" />
        <button type="submit" data-testid="ca-scope-all">
          Scope all
        </button>
      </form>
      <form action={clientUrlsScopeAction}>
        <input type="hidden" name="scope" value="none" />
        <button type="submit" data-testid="ca-scope-none">
          Scope none
        </button>
      </form>
    </div>
  );
}

function ActionClientItem() {
  const { data } = useLoader(ClientUrlsItemLoader);
  const { data: count } = useLoader(ClientUrlsCounterLoader);
  const { data: session } = useLoader(ClientUrlsSessionLoader);
  const params = useParams();

  return (
    <div data-testid="ca-item">
      <span data-testid="ca-item-param">{params.itemId}</span>
      <span data-testid="ca-item-loader">{data}</span>
      <span data-testid="ca-item-count">{count}</span>
      <span data-testid="ca-item-session">{session}</span>
      <button
        data-testid="ca-item-bump"
        onClick={() => void bumpClientUrlsCounter()}
      >
        Bump counter
      </button>
      <Link
        to="/client-urls-action/items/beta"
        prefetch="none"
        data-testid="ca-item-to-beta"
      >
        Item beta
      </Link>
      <Link
        to="/client-urls-action/items/beta"
        prefetch="hover"
        data-testid="ca-item-to-beta-prefetch"
      >
        Item beta (prefetched)
      </Link>
    </div>
  );
}

export default clientUrls(({ layout, path, loader, revalidate }) => [
  layout(ActionClientLayout, () => [
    loader(ClientUrlsCounterLoader),
    // Session pattern: load once, never revalidate — the server applies it
    // to every request kind (the action POST and same-route param-nav GETs,
    // prefetched or not).
    loader(ClientUrlsSessionLoader, () => [revalidate(false)]),
    // Rename-safe identity: re-run only when the imported target action
    // fired. A decoy (or the bump action) hard-falses and holds.
    loader(ClientUrlsIsActionTargetLoader, () => [
      revalidate(({ isAction }) => isAction(clientUrlsTargetAction)),
    ]),
    // Namespace form: `import * as Actions` matches any export of that
    // module — target AND decoy, but not bump (different module).
    loader(ClientUrlsIsActionNsLoader, () => [
      revalidate(({ isAction }) => isAction(ClientUrlsIsActions)),
    ]),
    path("/", ActionClientIndex, { name: "index" }, () => [
      // The action's outcome decides: re-run after a success, hold after a
      // failure. Other actions defer to the default.
      loader(ClientUrlsResultLoader, () => [
        revalidate(({ isAction, actionResult }) =>
          isAction(clientUrlsResultAction)
            ? actionResult?.ok === true
            : undefined,
        ),
      ]),
      // The submitted form decides.
      loader(ClientUrlsScopedLoader, () => [
        revalidate(({ formData }) => formData?.get("scope") === "all"),
      ]),
      loader(ClientUrlsAlwaysLoader, () => [revalidate(true)]),
    ]),
    path("/items/:itemId", ActionClientItem, { name: "item" }, () => [
      loader(ClientUrlsItemLoader),
    ]),
  ]),
]);
