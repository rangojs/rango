"use client";

import { useFetchLoader } from "@rangojs/router/client";
import { KeyRefreshRegisteredLoader } from "../loaders.js";

interface Props {
  id: string;
  /** Client refresh key. Omit for a no-key reader (its own bucket). */
  loaderKey?: string;
  withButton?: boolean;
}

/**
 * Reader of the route-registered KeyRefreshRegisteredLoader. All readers seed
 * from the same SSR-provided context value. After a keyed load(), only readers
 * sharing that key update; a no-key reader keeps the seeded value (its bucket
 * is the unkeyed loader id, a different bucket from the keyed group).
 */
export function KeyRefreshRegisteredWidget({
  id,
  loaderKey,
  withButton = false,
}: Props) {
  const { data, load } = useFetchLoader(
    KeyRefreshRegisteredLoader,
    loaderKey === undefined ? undefined : { key: loaderKey },
  );
  return (
    <div data-testid={`key-refresh-reg-${id}`}>
      <span data-testid={`key-refresh-reg-${id}-value`}>
        {data?.count ?? "—"}
      </span>
      {withButton && (
        <button
          data-testid={`key-refresh-reg-${id}-load-btn`}
          onClick={() => load().catch(() => {})}
        >
          Load
        </button>
      )}
    </div>
  );
}
