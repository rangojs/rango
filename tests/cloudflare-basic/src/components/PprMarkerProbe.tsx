"use client";

import { useSearchParams } from "@rangojs/router/client";

// Whether the forced-MISS reload marker (`_rsc_shell`) reached the search
// params the page renders with: the SSR search seed on the server, the
// browser location on the client. Both must read "absent" (the server strips
// the marker from the request, the client from the address bar at boot).
export function PprMarkerProbe() {
  const [params] = useSearchParams();
  return (
    <div data-testid="ppr-marker-probe">
      {`search-marker:${params.has("_rsc_shell") ? "present" : "absent"}`}
    </div>
  );
}
