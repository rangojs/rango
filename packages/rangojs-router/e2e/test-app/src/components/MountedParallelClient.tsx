"use client";

import { useMount, useHref } from "@rangojs/router/client";

/**
 * Client component rendered inside a mounted parallel slot.
 * Tests that useMount() and useHref() see the correct mount path
 * when rendered through Outlet/ParallelOutlet.
 */
export function MountedParallelClient() {
  const mount = useMount();
  const localHref = useHref();

  return (
    <div data-testid="mounted-parallel-client">
      <span data-testid="parallel-mount-path">{mount}</span>
      <span data-testid="parallel-local-href">{localHref("/sub")}</span>
    </div>
  );
}
