/**
 * Built-in Breadcrumbs handle for accumulating breadcrumb items across route segments.
 *
 * Each layout/route pushes breadcrumb items via `ctx.use(Breadcrumbs)`.
 * Items are collected in parent-to-child order with automatic deduplication
 * by `href` (last item for each href wins).
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
 * Flattens segments in parent-to-child order with deduplication by href
 * (last item for each href wins). Deferred slots (`ctx.use(Breadcrumbs).defer()`)
 * arrive as pending Promise entries with no href yet; they are passed through by
 * identity and excluded from the href dedup so concurrent deferred crumbs do not
 * all collapse under a single `undefined` href.
 */
function collectBreadcrumbs(segments: BreadcrumbItem[][]): BreadcrumbItem[] {
  const all = segments.flat();

  const isResolvedItem = (item: unknown): item is BreadcrumbItem =>
    item != null &&
    typeof item === "object" &&
    typeof (item as { then?: unknown }).then !== "function" &&
    typeof (item as { href?: unknown }).href === "string";

  const seen = new Map<string, number>();
  for (let i = 0; i < all.length; i++) {
    if (isResolvedItem(all[i])) seen.set(all[i].href, i);
  }

  // Deferred items bypass dedup (excluded via !isResolvedItem check).
  return all.filter(
    (item, index) => !isResolvedItem(item) || seen.get(item.href) === index,
  );
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
