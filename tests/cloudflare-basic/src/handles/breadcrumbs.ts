import { createHandle } from "@rangojs/router";
import type { ReactNode } from "react";

export interface BreadcrumbItem {
  label: string;
  href: string;
  /**
   * Optional async/element content rendered next to the crumb. A
   * Promise<ReactNode> here is the exact value shape the cache must round-trip
   * through Flight (JSON.stringify would flatten it to {}). Used by the
   * cached-handles regression fixture.
   */
  content?: ReactNode | Promise<ReactNode>;
}

/**
 * Breadcrumbs handle - accumulates breadcrumb items across route segments.
 * Each route can push breadcrumb items via ctx.use(Breadcrumbs).
 *
 * The default collect is the identity (one array per segment); this handle wants
 * a single flat list, so it opts in with `(segments) => segments.flat()`.
 *
 * The handle ID is auto-generated from file path + export name.
 */
export const Breadcrumbs = createHandle<BreadcrumbItem, BreadcrumbItem[]>(
  (segments) => segments.flat(),
);
