import { createHandle } from "@rangojs/router";

export interface BreadcrumbItem {
  label: string;
  href: string;
  content?: React.ReactNode | Promise<React.ReactNode>;
}

/**
 * Breadcrumbs handle - accumulates breadcrumb items across route segments.
 * Each layout/route can push breadcrumb items, and they are collected
 * in parent-to-child order for display.
 *
 * The default collect is the identity (one array per segment); this handle wants
 * a single flat list, so it opts in with `(segments) => segments.flat()`.
 *
 * The handle ID is auto-generated from file path + export name.
 */
export const Breadcrumbs = createHandle<BreadcrumbItem, BreadcrumbItem[]>(
  (segments) => segments.flat(),
);
