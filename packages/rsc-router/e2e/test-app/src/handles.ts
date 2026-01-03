import { createHandle } from "rsc-router/client";
import type { ReactNode } from "react";

export interface BreadcrumbItem {
  label: string;
  href: string;
  content?: ReactNode | Promise<ReactNode>;
}

/**
 * Breadcrumbs handle - accumulates breadcrumb items across route segments.
 * Each layout/route can push breadcrumb items, and they are collected
 * in parent-to-child order for display.
 */
export const Breadcrumbs = createHandle<BreadcrumbItem>();
