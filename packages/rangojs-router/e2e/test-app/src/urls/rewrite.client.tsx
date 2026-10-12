"use client";

import { usePathname, useSearchParams } from "@rangojs/router/client";

/** The location a rewritten page hydrates with: the visitor's URL. */
export function RwClientLocation() {
  const pathname = usePathname();
  const [search] = useSearchParams();
  const query = search.toString();
  return (
    <span data-testid="rw-client-location">
      {query ? `${pathname}?${query}` : pathname}
    </span>
  );
}
