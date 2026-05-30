"use client";

import {
  useFetchLoader,
  useRefreshLoaders,
  type LoaderDefinition,
} from "@rangojs/router/client";
import { KeyRefreshGroupLoaderA, KeyRefreshGroupLoaderB } from "../loaders.js";
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
