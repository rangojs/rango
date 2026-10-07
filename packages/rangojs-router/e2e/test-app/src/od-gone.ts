// In-process stand-in for a data source that deleted a product: the plain
// on-demand producer (urls/on-demand-prerender.tsx) calls notFound() for a slug
// in this set. The e2e adds and removes slugs through /od-plain-trigger
// (?gone=1 / ?gone=0), so a refresh can hit notFound() and store the "removed"
// marker (e2e/on-demand-prerender.test.ts).
export const goneSlugs: Set<string> = new Set();

// The same for a data source that is down: the plain producer throws for a
// slug in this set (?fail=1 / ?fail=0), so a refresh is `render-failed`.
export const failSlugs: Set<string> = new Set();
