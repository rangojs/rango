"use client";

import { useRouter } from "@rangojs/router/client";

/** router.refresh() sends a stale partial (`_rsc_stale`). */
export function NotReusedNoStoreRefresh() {
  const router = useRouter();
  return (
    <button data-testid="nrns-refresh" onClick={() => void router.refresh()}>
      Refresh
    </button>
  );
}
