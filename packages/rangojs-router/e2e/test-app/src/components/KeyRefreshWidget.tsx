"use client";

import { useFetchLoader, useRefreshLoaders } from "@rangojs/router/client";
import { KeyRefreshLoader } from "../loaders.js";

interface Props {
  /** Identifier rendered into data-testids so each widget can be read independently. */
  id: string;
  /**
   * Client refresh key. When two widgets share a key, a load() from one
   * refreshes both. When undefined, the load stays local to this widget
   * (the loader is unregistered, so there is no shared route context).
   */
  loaderKey?: string;
  /**
   * Cross-loader refresh group tag(s) — one name or several. A grouped reader
   * with no `loaderKey` gets a private bucket, so a group refresh cannot leak
   * into the bare loader id bucket that unrelated unkeyed readers share.
   */
  refreshGroup?: string | string[];
  /** Whether to render the load() button. Read-only siblings omit it. */
  withButton?: boolean;
}

/**
 * Standalone button that refreshes one or more cross-loader groups by name.
 * `group` is passed straight to the inverted `useRefreshLoaders()` function, so
 * an array triggers a single union refresh across the named groups.
 */
export function KeyRefreshGroupButton({
  id,
  group,
}: {
  id: string;
  group: string | string[];
}) {
  const refresh = useRefreshLoaders();
  return (
    <button
      data-testid={`key-refresh-group-btn-${id}`}
      onClick={() => refresh(group).catch(() => {})}
    >
      Refresh {Array.isArray(group) ? group.join("+") : group}
    </button>
  );
}

/**
 * Reader of the unregistered KeyRefreshLoader. Used across the key-refresh
 * scenarios: same key (group refresh), distinct keys (independent), and no key
 * (local). Initial value is "—" because an unregistered loader has no route
 * context to seed from until a load() runs.
 */
export function KeyRefreshWidget({
  id,
  loaderKey,
  refreshGroup,
  withButton = true,
}: Props) {
  const { data, load } = useFetchLoader(
    KeyRefreshLoader,
    loaderKey === undefined && refreshGroup === undefined
      ? undefined
      : { key: loaderKey, refreshGroup },
  );
  return (
    <div data-testid={`key-refresh-${id}`}>
      <span data-testid={`key-refresh-${id}-value`}>{data?.count ?? "—"}</span>
      {withButton && (
        <button
          data-testid={`key-refresh-${id}-load-btn`}
          onClick={() => load().catch(() => {})}
        >
          Load
        </button>
      )}
    </div>
  );
}
