"use client";

import { useFetchLoader } from "@rangojs/router/client";
import { SharedRefetchParamLoader } from "../loaders.js";

interface Props {
  /** Identifier rendered into data-testids so the test can read each widget independently. */
  id: string;
  /** Tag value sent in load({ params: { tag } }) — must round-trip back into the rendered tag. */
  tag: string;
}

/**
 * Parameterized-fetch widget. Two of these mount on /shared-refetch-params
 * with different tags. Each calls `load({ params: { tag } })` and must
 * render its own tag — proving parameterized loads stay local and don't
 * clobber each other through the shared store (which would manifest as
 * last-write-wins where both widgets eventually show the same tag).
 */
export function SharedRefetchParamWidget({ id, tag }: Props) {
  const { data, load } = useFetchLoader(SharedRefetchParamLoader);
  return (
    <div data-testid={`shared-refetch-param-${id}`}>
      <span data-testid={`shared-refetch-param-${id}-tag`}>
        {data?.tag ?? "—"}
      </span>
      <button
        data-testid={`shared-refetch-param-${id}-load-btn`}
        onClick={() => load({ params: { tag } })}
      >
        Load {tag}
      </button>
    </div>
  );
}
