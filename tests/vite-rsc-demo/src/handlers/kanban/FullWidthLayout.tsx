"use client";

import { useEffect, type ReactNode } from "react";

export function FullWidthLayout({ children }: { children: ReactNode }) {
  return <div style={{ width: "100%", minHeight: "100%" }}>{children}</div>;
}
