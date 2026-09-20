import { useEffect } from "react";

declare global {
  interface Window {
    __swrStatusLog?: string[];
    __txShellStatusLog?: string[];
  }
}

/**
 * Probe helper: append every DISTINCT value of `status` to `window[logKey]`
 * so an e2e can assert the exact render sequence, not a point-in-time read.
 */
export function useStatusLog(
  logKey: "__swrStatusLog" | "__txShellStatusLog",
  status: string,
): void {
  useEffect(() => {
    const log = (window[logKey] ??= []);
    if (log[log.length - 1] !== status) log.push(status);
  }, [logKey, status]);
}
