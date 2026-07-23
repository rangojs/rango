/**
 * /site-admin: deliberately overlaps /site as a STRING prefix ("/site" is a
 * prefix of "/site-admin" but not a path-segment prefix). Pins that trie
 * walk and fallback prefix-skipping compare whole segments, not raw string
 * prefixes — /site-admin/* must never be routed into (or skipped with) the
 * /site group.
 */
import { urls, type Handler, type UrlPatterns } from "@rangojs/router";
import { jsonThrow } from "./stress/json-throw.js";

const AdminPage: Handler<Record<string, any>> = async (ctx) =>
  jsonThrow({ route: ctx.pathname, group: "site-admin" });

export const siteAdminPatterns: UrlPatterns<any> = urls(({ path }) => [
  ...Array.from({ length: 40 }, (_, i) =>
    path(`/p${i + 1}`, AdminPage, { name: `p${i + 1}` }),
  ),
]);

export default siteAdminPatterns;
