"use client";

import { useLinkStatus } from "@rangojs/router/client";

export function LinkStatusIndicator() {
  const { pending } = useLinkStatus();
  return pending ? <span data-testid="link-pending">Loading...</span> : null;
}
