import { createHandle } from "@rangojs/router";

// Breadcrumbs handle: route handlers push items via ctx.use(Breadcrumbs); the
// client BreadcrumbNav reads them reactively with useHandle(Breadcrumbs). The
// handle id is auto-generated from the file path + export name.
//
// The default collect is the identity (one array per segment); this handle wants
// a single flat list, so it opts in with (segments) => segments.flat().
export const Breadcrumbs = createHandle((segments) => segments.flat());
