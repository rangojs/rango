"use client";

import type { ReactNode } from "react";

// Referenced only from ClientUrlsElementLoader's answer, so the document's
// Flight client loads it when that answer arrives.
export function ClientUrlsElementBadge({
  label,
}: {
  label: string;
}): ReactNode {
  return <span data-testid="cle-badge">{label}</span>;
}
