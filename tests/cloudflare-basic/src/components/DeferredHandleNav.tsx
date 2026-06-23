"use client";

import {
  useHandle,
  Breadcrumbs,
  type BreadcrumbItem,
  type DeferredHandleEntry,
} from "@rangojs/router/client";
import { Suspense, use } from "react";

/** Local thenable guard. isThenable is not a public export, so the consumer
 *  narrows DeferredHandleEntry promises with its own guard, exactly as the
 *  documented contract intends. */
function isThenable<T>(v: unknown): v is Promise<T> {
  return v != null && typeof (v as { then?: unknown }).then === "function";
}

function DeferredCrumb({
  crumb,
}: {
  crumb: DeferredHandleEntry<BreadcrumbItem>;
}) {
  const item = isThenable<BreadcrumbItem | null | undefined>(crumb)
    ? use(crumb)
    : crumb;
  if (!item) return null; // deferred slot timed out with else: null / undefined
  return <span>{item.label}</span>;
}

/**
 * Deferred-aware renderer that makes the PENDING state observable. For each
 * entry, if it is still a Promise (a deferred slot not yet resolved), the
 * Suspense fallback renders a visible pending marker while use() suspends; once
 * resolved, the crumb's label replaces it. This pins the P2 contract: during a
 * SOFT navigation a deferred non-Meta handle must reach the consumer AS A
 * PROMISE (so the consumer can show a pending UI), not pre-resolved by the
 * store. The built-in Breadcrumbs handle is used here (not the app's local one)
 * because only the built-in supports ctx.use(Breadcrumbs).defer().
 */
export function DeferredPendingBreadcrumbs() {
  const breadcrumbs = useHandle(Breadcrumbs) as Array<
    DeferredHandleEntry<BreadcrumbItem>
  >;

  return (
    <nav aria-label="DeferredPending" data-testid="deferred-pending-nav">
      <span data-testid="deferred-pending-count">{breadcrumbs.length}</span>
      <ol>
        {breadcrumbs.map((crumb, index) => {
          // The contract assertion: a deferred entry is observed AS A PROMISE
          // here. A pending marker shows until it resolves.
          const pending = isThenable<BreadcrumbItem | null | undefined>(crumb);
          return (
            <li key={index} data-pending={pending ? "true" : "false"}>
              <Suspense
                fallback={
                  <span data-testid={`crumb-pending-${index}`}>pending</span>
                }
              >
                <DeferredCrumb crumb={crumb} />
              </Suspense>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
