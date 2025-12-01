"use client";

import { useEffect, type ReactNode } from "react";

export function FullWidthLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add("full-width");
    return () => {
      document.body.classList.remove("full-width");
    };
  }, []);

  return <>{children}</>;
}
