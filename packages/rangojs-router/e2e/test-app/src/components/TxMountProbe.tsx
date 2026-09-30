"use client";

import { useEffect, useState } from "react";
import { useRouter } from "@rangojs/router/client";

/**
 * transition({ when }) e2e probe: counts mounts (window.__txMounts) and keeps
 * a click counter, so a reconcile keeps `clicks:N` and a remount resets it to
 * 0 (#995). Also triggers router.refresh() (kind "revalidate").
 */
export function TxMountProbe() {
  const [clicks, setClicks] = useState(0);
  const router = useRouter();
  useEffect(() => {
    const w = window as unknown as { __txMounts?: number };
    w.__txMounts = (w.__txMounts ?? 0) + 1;
  }, []);
  return (
    <>
      <button
        type="button"
        data-testid="tx-probe"
        onClick={() => setClicks((c) => c + 1)}
      >
        {`clicks:${clicks}`}
      </button>
      <button
        type="button"
        data-testid="tx-refresh"
        onClick={() => void router.refresh()}
      >
        refresh
      </button>
    </>
  );
}
