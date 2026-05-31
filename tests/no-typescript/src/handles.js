import { createHandle } from "@rangojs/router";

// Breadcrumbs handle: route handlers push items via ctx.use(Breadcrumbs); the
// client BreadcrumbNav reads them reactively with useHandle(Breadcrumbs). The
// handle id is auto-generated from the file path + export name.
export const Breadcrumbs = createHandle();
