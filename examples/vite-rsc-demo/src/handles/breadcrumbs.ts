import { createHandle } from "rsc-router/client";

export interface BreadcrumbItem {
  label: string;
  href: string;
}

/**
 * Breadcrumbs handle - accumulates breadcrumb items across route segments.
 * Each layout/route can push breadcrumb items, and they are collected
 * in parent-to-child order for display.
 */
export const Breadcrumbs = createHandle<BreadcrumbItem>("breadcrumbs");
