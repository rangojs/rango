"use client";

import {
  useHandle,
  Breadcrumbs,
  type BreadcrumbItem,
} from "@rangojs/router/client";
import { Fragment, Suspense, use, type ReactNode } from "react";

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

function AsyncContent({
  content,
}: {
  content: ReactNode | Promise<ReactNode>;
}) {
  if (!(content instanceof Promise)) return <>{content}</>;
  return <>{use(content)}</>;
}

function isThenable<T>(v: unknown): v is Promise<T> {
  return v != null && typeof (v as { then?: unknown }).then === "function";
}

/**
 * Deferred-aware renderer: a `ctx.use(Breadcrumbs).defer()` slot arrives as a
 * Promise<BreadcrumbItem | null> in the handle data (resolved late by a deep
 * component, or to the `else` fallback on timeout). `use()` the item, then render
 * it like any other crumb. Kept separate from TrailBreadcrumbs so the existing
 * (non-deferred) breadcrumb tests are unaffected.
 */
export function DeferredTrailBreadcrumbs() {
  const breadcrumbs = useHandle(Breadcrumbs) as Array<
    BreadcrumbItem | Promise<BreadcrumbItem | null>
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
  crumb: BreadcrumbItem | Promise<BreadcrumbItem | null>;
}) {
  const item = isThenable<BreadcrumbItem | null>(crumb) ? use(crumb) : crumb;
  if (!item) return null; // deferred slot timed out with else: null
  return (
    <>
      <span>{item.label}</span>
      {item.content != null && <AsyncContent content={item.content} />}
    </>
  );
}
