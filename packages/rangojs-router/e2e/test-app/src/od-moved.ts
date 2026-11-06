// In-process stand-in for a data source that moved a page: the plain on-demand
// producer (urls/on-demand-prerender.tsx) throws redirect(target) for a slug in
// this map. The e2e sets and clears entries through /od-plain-trigger
// (?move=<target> / ?move=0), so a refresh answers with a redirect and stores
// it in place of the page (e2e/on-demand-prerender.test.ts).
export const movedSlugs: Map<string, string> = new Map();
