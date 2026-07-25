"use client";

import { useEffect } from "react";
import { useHandle } from "@rangojs/router/client";
import { Meta } from "../handles/meta.js";

/**
 * Applies the Meta handle's title to document.title. Renders nothing.
 * useHandle re-renders on every handle update — including LATE loader pushes
 * (document lane: metadata.handlesLate applied post-hydration; nav lane: the
 * progressive handles generator) — so the title follows the data whenever it
 * lands.
 */
export function TitleUpdater() {
  const meta = useHandle(Meta);

  useEffect(() => {
    if (meta?.title) {
      document.title = meta.title;
    }
  }, [meta?.title]);

  return null;
}
