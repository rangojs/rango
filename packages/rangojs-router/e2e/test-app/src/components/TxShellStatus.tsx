"use client";

import { useLoader } from "@rangojs/router/client";
import { TxShellLoader } from "../loaders.js";
import { useStatusLog } from "./status-log.js";

/**
 * Layout-level probe: reads TxShellLoader (registered on TxShellLayout, not
 * re-run by a same-route nav inside the block). Must never report "stale"
 * while a child route's loader streams.
 */
export function TxShellStatus(): React.ReactNode {
  const { data, isLoading } = useLoader(TxShellLoader);
  const status = `${isLoading ? "stale" : "fresh"}:${data.label}`;
  useStatusLog("__txShellStatusLog", status);
  return (
    <p data-testid="tx-shell-status" data-loaded-at={data.loadedAt}>
      {status}
    </p>
  );
}
