"use client";

import { useHandle } from "@rangojs/router/client";
import { SlowMetaHandles } from "../urls/shell-cache.defs.js";

/**
 * Consumer for the slow deferred-shell-material fixture (issue #715). Every
 * push is TOP-LEVEL, so by the time the payload's handles row emits (and the
 * capture gate releases) all parts are resolved strings — shell material that
 * bakes into the stored prelude. Rendering all values in one span makes the
 * prelude assertion a plain substring check per part.
 */
export function SlowMetaView() {
  const parts = useHandle(SlowMetaHandles) ?? [];
  return (
    <div data-testid="slow-meta-view">
      {parts.map((p, i) => (
        <span key={i} data-testid={`slow-meta-part-${i}`}>
          {p}
        </span>
      ))}
    </div>
  );
}
