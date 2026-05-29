"use client";

import { useFetchLoader } from "@rangojs/router/client";
import { KeyRefreshParamLoader } from "../loaders.js";

interface Props {
  id: string;
  loaderKey: string;
  /** "get" issues load({ params }); "post" issues a mutation load({ method, body }). */
  mode?: "get" | "post";
  tag?: string;
  withButton?: boolean;
}

/**
 * Exercises the widened keyed semantics:
 *   - mode "get":  load({ params: { tag } }) — a parameterized GET, which a
 *     `key` makes shareable across same-key readers.
 *   - mode "post": load({ method: "POST", body: { tag } }) — a mutation, which
 *     stays local to the caller even with a key.
 */
export function KeyRefreshParamWidget({
  id,
  loaderKey,
  mode = "get",
  tag = "alpha",
  withButton = true,
}: Props) {
  const { data, load } = useFetchLoader(KeyRefreshParamLoader, {
    key: loaderKey,
  });
  const run = () =>
    (mode === "post"
      ? load({ method: "POST", body: { tag } })
      : load({ params: { tag } })
    ).catch(() => {});
  return (
    <div data-testid={`key-refresh-param-${id}`}>
      <span data-testid={`key-refresh-param-${id}-tag`}>
        {data?.tag ?? "—"}
      </span>
      {withButton && (
        <button data-testid={`key-refresh-param-${id}-load-btn`} onClick={run}>
          Load {tag}
        </button>
      )}
    </div>
  );
}
