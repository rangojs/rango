"use client";

import { useHandle } from "@rangojs/router/client";
import { PprSlowMetaHandles } from "../loaders/ppr-slow-meta.js";

/**
 * Consumer for the deferred-shell-material fixtures (issue #715). Every push
 * is TOP-LEVEL, so by the time the payload's handles row emits (and the
 * capture gate releases) all parts are resolved strings — shell material that
 * bakes into the stored prelude. One span per part keeps the prelude
 * assertion a plain substring check.
 */
export function PprSlowMetaView() {
  const parts = useHandle(PprSlowMetaHandles) ?? [];
  return (
    <div data-testid="ppr-slow-meta-view">
      {parts.map((p, i) => (
        <span key={i} data-testid={`ppr-slow-meta-part-${i}`}>
          {p}
        </span>
      ))}
    </div>
  );
}
