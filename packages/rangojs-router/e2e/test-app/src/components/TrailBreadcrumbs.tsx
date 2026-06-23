"use client";

import {
  useHandle,
  Breadcrumbs,
  type BreadcrumbItem,
  type DeferredHandleEntry,
} from "@rangojs/router/client";
import { Fragment, Suspense, use } from "react";
import { AsyncContent } from "./AsyncContent.js";
import { isThenable } from "./thenable.js";

/**
 * User-land breadcrumb component using the built-in Breadcrumbs handle.
 * Tests that useHandle(Breadcrumbs) works correctly with a custom renderer.
 */
export function TrailBreadcrumbs() {
  const breadcrumbs = useHandle(Breadcrumbs);

  if (!breadcrumbs.length) return null;

  return (
    <nav aria-label="Trail">
      <ol>
        {breadcrumbs.map((crumb, index) => (
          <Fragment key={crumb.href}>
            <li>
              {index > 0 && <span aria-hidden="true">›</span>}
              {index === breadcrumbs.length - 1 ? (
                <span aria-current="page">{crumb.label}</span>
              ) : (
                <a href={crumb.href}>{crumb.label}</a>
              )}
            </li>
            {crumb.content != null && (
              <li>
                <Suspense>
                  <AsyncContent content={crumb.content} />
                </Suspense>
              </li>
            )}
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

/**
 * Deferred-aware renderer: unwraps Promise-wrapped breadcrumb items (from `.defer()`)
 * using React's `use()` hook inside Suspense. Separate from TrailBreadcrumbs
 * so existing tests are unaffected.
 */
export function DeferredTrailBreadcrumbs() {
  const breadcrumbs = useHandle(Breadcrumbs) as Array<
    DeferredHandleEntry<BreadcrumbItem>
  >;

  if (!breadcrumbs.length) return null;

  return (
    <nav aria-label="DeferredTrail">
      <ol>
        {breadcrumbs.map((crumb, index) => (
          <li key={index}>
            <Suspense>
              <DeferredCrumb crumb={crumb} />
            </Suspense>
          </li>
        ))}
      </ol>
    </nav>
  );
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
  return (
    <>
      <span>{item.label}</span>
      {item.content != null && <AsyncContent content={item.content} />}
    </>
  );
}

/**
 * Deferred-aware renderer that makes the PENDING state observable. For each
 * entry, if it is still a Promise (a deferred slot not yet resolved), it renders
 * a visible pending marker via the Suspense fallback while use() suspends; once
 * resolved, the crumb's label replaces it. This pins the P2 contract: during a
 * SOFT navigation a deferred non-Meta handle must reach the consumer AS A PROMISE
 * (so the consumer can show a pending UI), not pre-resolved by the store.
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
          // here. We render a pending marker until it resolves.
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
