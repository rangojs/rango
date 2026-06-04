"use client";

import {
  useFetchLoader,
  useRefreshLoaders,
  type LoaderDefinition,
} from "@rangojs/router/client";
import {
  KeyRefreshGroupLoaderA,
  KeyRefreshGroupLoaderB,
  KeyRefreshGroupFailLoader,
} from "../loaders.js";
import { KeyRefreshGroupButton } from "./KeyRefreshWidget.js";

const GROUP = "account";

interface WidgetProps {
  id: string;
  loader: LoaderDefinition<{ count: number }>;
}

/**
 * One member of a cross-loader refresh group. Each instance reads a DIFFERENT
 * loader but shares the same `refreshGroup`, so a single useRefreshLoaders()
 * call re-runs all of them. The `key` is shared too, mirroring the realistic
 * "keyed per-entity reads grouped for a coordinated refresh" pattern.
 */
function Widget({ id, loader }: WidgetProps) {
  const { data } = useFetchLoader(loader, { key: "u1", refreshGroup: GROUP });
  return (
    <div data-testid={`key-refresh-group-${id}`}>
      <span data-testid={`key-refresh-group-${id}-value`}>
        {data?.count ?? "—"}
      </span>
    </div>
  );
}

/** Triggers a refresh of every loader in the group. */
function RefreshButton() {
  const refresh = useRefreshLoaders();
  return (
    <button
      data-testid="key-refresh-group-refresh-btn"
      onClick={() => refresh(GROUP).catch(() => {})}
    >
      Refresh account
    </button>
  );
}

export function KeyRefreshGroupPage() {
  return (
    <div data-testid="key-refresh-group-page">
      <h1>Key Refresh — Cross-loader Group</h1>
      <Widget id="A" loader={KeyRefreshGroupLoaderA} />
      <Widget id="B" loader={KeyRefreshGroupLoaderB} />
      <RefreshButton />
    </div>
  );
}

/**
 * One member of the multi-tag scenario. Each reads a DIFFERENT loader but is
 * tagged into SEVERAL groups at once via an array `refreshGroup`. No `key`, so
 * each gets a private bucket; the first value streams in on the first group
 * refresh (the same plain-GET refetch path the single-tag group uses).
 */
function MultiTagReader({
  id,
  loader,
  groups,
}: {
  id: string;
  loader: LoaderDefinition<{ count: number }>;
  groups: string[];
}) {
  const { data } = useFetchLoader(loader, { refreshGroup: groups });
  return (
    <div data-testid={`key-refresh-mt-${id}`}>
      <span data-testid={`key-refresh-mt-${id}-value`}>
        {data?.count ?? "—"}
      </span>
    </div>
  );
}

/**
 * Multi-tag groups: reader A is in ["all", "left"], reader B is in
 * ["all", "right"]. A fine tag refreshes one reader; the coarse "all" tag or the
 * union argument ["left", "right"] refreshes both — granular vs. whole-set
 * refresh from a single inverted useRefreshLoaders().
 */
export function KeyRefreshMultiTagPage() {
  return (
    <div data-testid="key-refresh-multitag-page">
      <h1>Key Refresh — Multi-tag Groups</h1>
      <MultiTagReader
        id="A"
        loader={KeyRefreshGroupLoaderA}
        groups={["all", "left"]}
      />
      <MultiTagReader
        id="B"
        loader={KeyRefreshGroupLoaderB}
        groups={["all", "right"]}
      />
      <KeyRefreshGroupButton id="left" group="left" />
      <KeyRefreshGroupButton id="right" group="right" />
      <KeyRefreshGroupButton id="all" group="all" />
      <KeyRefreshGroupButton id="both" group={["left", "right"]} />
    </div>
  );
}

const ERR_GROUP = "errgroup";

/**
 * One member of a group that contains a failing loader. Surfaces `error` rather
 * than render-throwing — a group refresh never render-throws, so the default
 * throwOnError reader still shows the error via the hook instead of tripping a
 * boundary.
 */
function ErrorMember({ id, loader }: WidgetProps) {
  const { data, error } = useFetchLoader(loader, { refreshGroup: ERR_GROUP });
  return (
    <div data-testid={`key-refresh-errgroup-${id}`}>
      <span data-testid={`key-refresh-errgroup-${id}-value`}>
        {data?.count ?? "—"}
      </span>
      <span data-testid={`key-refresh-errgroup-${id}-error`}>
        {error ? error.message : "—"}
      </span>
    </div>
  );
}

/** Refreshes the group; swallows the AggregateError at the await site. */
function ErrorRefreshButton() {
  const refresh = useRefreshLoaders();
  return (
    <button
      data-testid="key-refresh-errgroup-refresh-btn"
      onClick={() => refresh(ERR_GROUP).catch(() => {})}
    >
      Refresh group
    </button>
  );
}

/**
 * A refresh group with one healthy and one always-failing member. Proves the
 * failure contract: the page does not throw to an error boundary, the failing
 * member exposes its error, and the healthy member still advances.
 */
export function KeyRefreshGroupErrorPage() {
  return (
    <div data-testid="key-refresh-errgroup-page">
      <h1>Key Refresh — Group with a failing member</h1>
      <ErrorMember id="ok" loader={KeyRefreshGroupLoaderA} />
      <ErrorMember id="fail" loader={KeyRefreshGroupFailLoader} />
      <ErrorRefreshButton />
    </div>
  );
}
