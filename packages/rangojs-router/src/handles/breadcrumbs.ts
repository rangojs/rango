/**
 * Built-in Breadcrumbs handle for accumulating breadcrumb items across route segments.
 *
 * Each layout/route pushes breadcrumb items via `ctx.use(Breadcrumbs)`.
 * Items are collected in parent-to-child order with automatic deduplication
 * by `href`: each href keeps its FIRST position but takes the LAST value, so a
 * child re-pushing a parent href refreshes the label without reordering the trail.
 *
 * @example
 * ```tsx
 * // In route handler
 * route("/blog/:slug", (ctx) => {
 *   const breadcrumb = ctx.use(Breadcrumbs);
 *   breadcrumb({ label: "Blog", href: "/blog" });
 *   breadcrumb({ label: post.title, href: `/blog/${ctx.params.slug}` });
 * });
 *
 * // In client component (consume with useHandle)
 * const crumbs = useHandle(Breadcrumbs);
 * crumbs.map((c) => <a href={c.href}>{c.label}</a>);
 * ```
 */

import type { ReactNode } from "react";
import { createHandle, type Handle } from "../handle.js";

/**
 * A single breadcrumb item.
 *
 * @property label - Display text for the breadcrumb
 * @property href - URL the breadcrumb links to
 * @property content - Optional extra content (sync or async) rendered alongside the label
 */
export interface BreadcrumbItem {
  label: string;
  href: string;
  content?: ReactNode | Promise<ReactNode>;
}

/**
 * Collect function for Breadcrumbs handle.
 * Flattens segments in parent-to-child order with deduplication by href: each
 * href keeps its FIRST position but takes the LAST value (re-pushing a parent
 * href refreshes the label in place without reordering the trail). Deferred
 * crumbs (a pushed Promise or `ctx.use(Breadcrumbs).defer()`) are resolved
 * BEFORE collect runs (resolve-by-default), so collect only ever sees resolved
 * items. An item without a string `href` is passed through by identity and
 * excluded from the href dedup.
 */
function collectBreadcrumbs(segments: BreadcrumbItem[][]): BreadcrumbItem[] {
  const all = segments.flat();

  const hasHref = (item: unknown): item is BreadcrumbItem =>
    item != null &&
    typeof item === "object" &&
    typeof (item as { href?: unknown }).href === "string";

  // Dedup crumbs by href: keep the FIRST position (preserving parent->child
  // order) but the LAST value (a child re-pushing a parent's href can refresh
  // its label). Items without an href pass through by identity at their original
  // position.
  const valueByHref = new Map<string, BreadcrumbItem>();
  for (const item of all) {
    if (hasHref(item)) valueByHref.set(item.href, item);
  }

  const result: BreadcrumbItem[] = [];
  const emitted = new Set<string>();
  for (const item of all) {
    if (!hasHref(item)) {
      result.push(item);
      continue;
    }
    // Emit each href once, at its first occurrence, with the final value.
    if (!emitted.has(item.href)) {
      emitted.add(item.href);
      result.push(valueByHref.get(item.href)!);
    }
  }
  return result;
}

/**
 * Built-in handle for accumulating breadcrumb navigation items.
 *
 * Use `ctx.use(Breadcrumbs)` in route handlers to push breadcrumb items.
 * Use `useHandle(Breadcrumbs)` in client components to consume them.
 */
export const Breadcrumbs: Handle<BreadcrumbItem, BreadcrumbItem[]> =
  createHandle<BreadcrumbItem, BreadcrumbItem[]>(
    collectBreadcrumbs,
    "__rsc_router_breadcrumbs__",
  );
