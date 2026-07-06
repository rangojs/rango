/**
 * Factories for the mega chain and dup pair modules. The MODULES stay
 * separate files — Rollup needs one module per async chunk and the literal
 * `() => import()` thunks stay in the calling module — but their bodies were
 * copy-paste; the content lives here once. Wide UrlPatterns<any> annotations
 * for the same reason as makeRouteGroup (see factory.tsx).
 */
import { urls, type Handler, type UrlPatterns } from "@rangojs/router";
import { jsonThrow } from "./json-throw.js";

/**
 * One level of the 3-level async include chain (/mega -> /mega/l2 ->
 * /mega/l2/l3). Pass the next level's import thunk from the level module so
 * the literal specifier stays in that module.
 */
export function makeMegaLevel(
  level: number,
  child?: () => Promise<{ default: UrlPatterns<any> }>,
): UrlPatterns<any> {
  const MegaPage: Handler<Record<string, any>> = async (ctx) =>
    jsonThrow({ route: ctx.pathname, level, params: ctx.params });

  return urls(({ path, include }) => [
    ...Array.from({ length: 30 }, (_, i) =>
      path(`/p${i + 1}/:id?`, MegaPage, { name: `p${i + 1}` }),
    ),

    ...(child
      ? [include(`/l${level + 1}`, child, { name: `l${level + 1}` })]
      : []),
  ]);
}

/**
 * One half of the same-staticPrefix sibling pair (/dup/:cat + /dup/:brand).
 * Route sets are disjoint by the segment after the param.
 */
export function makeDupGroup(
  groupLabel: string,
  namePrefix: string,
  slugPrefix: string,
): UrlPatterns<any> {
  const DupPage: Handler<Record<string, any>> = async (ctx) =>
    jsonThrow({ route: ctx.pathname, group: groupLabel, params: ctx.params });

  return urls(({ path }) => [
    ...Array.from({ length: 5 }, (_, i) =>
      path(`/${slugPrefix}${i + 1}`, DupPage, {
        name: `${namePrefix}${i + 1}`,
      }),
    ),
  ]);
}
