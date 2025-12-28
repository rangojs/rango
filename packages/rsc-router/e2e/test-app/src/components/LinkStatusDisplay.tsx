"use client";

import { useLinkStatus } from "rsc-router/client";

/**
 * Loading indicator that shows when the parent Link is pending
 */
export function LinkLoadingIndicator() {
  const { pending } = useLinkStatus();

  if (!pending) return null;

  return (
    <span
      data-testid="link-loading"
      style={{
        marginLeft: "8px",
        color: "#666",
      }}
    >
      ⏳
    </span>
  );
}

/**
 * Badge that shows pending state for testing
 */
export function LinkPendingBadge() {
  const { pending } = useLinkStatus();

  return (
    <span
      data-testid="link-pending-badge"
      data-pending={pending ? "true" : "false"}
      style={{
        marginLeft: "8px",
        padding: "2px 6px",
        borderRadius: "4px",
        fontSize: "12px",
        backgroundColor: pending ? "#fef3c7" : "#e5e7eb",
        color: pending ? "#92400e" : "#6b7280",
      }}
    >
      {pending ? "pending" : "idle"}
    </span>
  );
}
