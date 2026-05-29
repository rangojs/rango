"use client";

import {
  useFetchLoader,
  useRefreshLoaders,
  type LoaderDefinition,
} from "@rangojs/router/client";
import { KeyRefreshGroupLoaderA, KeyRefreshGroupLoaderB } from "../loaders.js";

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
  const refreshAccount = useRefreshLoaders(GROUP);
  return (
    <button
      data-testid="key-refresh-group-refresh-btn"
      onClick={() => refreshAccount().catch(() => {})}
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
