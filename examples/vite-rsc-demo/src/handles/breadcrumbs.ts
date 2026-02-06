import { createHandle } from "@rangojs/router/client";

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
 * The handle ID is auto-generated from file path + export name.
 */
export const Breadcrumbs = createHandle<BreadcrumbItem>();
