import { createHandle } from "@rangojs/router/client";

export interface BreadcrumbItem {
  label: string;
  href: string;
}

/**
 * Breadcrumbs handle - accumulates breadcrumb items across route segments.
 * Each route can push breadcrumb items via ctx.use(Breadcrumbs).
 *
 * The handle ID is auto-generated from file path + export name.
 */
export const Breadcrumbs = createHandle<BreadcrumbItem>();
