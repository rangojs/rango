import { createHandle } from "rsc-router/client";

export interface Breadcrumb {
  label: string;
  href: string;
}

export const breadcrumbs = createHandle<Breadcrumb>("breadcrumbs");
