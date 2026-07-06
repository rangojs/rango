/**
 * Shared factory for generated route groups (src/groups/group-*.ts).
 *
 * A shared factory does NOT defeat per-group chunking: the bundler keeps this
 * module in the common chunk while each `() => import("./group-N.js")`
 * literal in the hub stays its own chunk. Build-time discovery evaluates the
 * provider, so loop-generated routes are fully discovered at build.
 *
 * Every group carries the shape mix the original modules lack: 5-deep static
 * paths, multi-param (3 and 5), optional params, literal-suffix params
 * (longest-suffix-wins tier), and named catch-alls (:rest+ / :rest*).
 * Handlers use Handler<Record<string, any>> to bypass the PathFn
 * biconditional — the cheap-typecheck pattern the other stress modules use.
 */
import { urls, type Handler, type UrlPatterns } from "@rangojs/router";
import { jsonThrow } from "./json-throw.js";
import { SCALE } from "./scale.js";

const GroupPage: Handler<Record<string, any>> = async (ctx) => {
  return (
    <div>
      <h1>Group route</h1>
      <p>{ctx.pathname}</p>
      <pre>{JSON.stringify(ctx.params)}</pre>
    </div>
  );
};

const GroupBenchHandler: Handler<Record<string, any>> = async (ctx) =>
  jsonThrow({ route: ctx.pathname, params: ctx.params });

const n = (base: number) => Math.max(1, Math.round(base * SCALE));

/**
 * Return type is the WIDE UrlPatterns deliberately: without it, the root
 * urls() in urls.tsx infers through hub -> 50 groups -> ~240 entries each and
 * type instantiations blow up 36x (measured 112k -> 4.05M, check 3.9s ->
 * 20s). Named-route typing comes from the committed gen file, so nothing is
 * lost by widening here.
 */
export function makeRouteGroup(groupId: string): UrlPatterns<any> {
  return urls(({ path }) => [
    // Bench markers, first and last, per group
    path("/bench/first", GroupBenchHandler, { name: "benchFirst" }),

    // Deep static nesting (5 segments before the leaf)
    ...Array.from({ length: n(60) }, (_, i) =>
      path(`/deep/a/b/c/p${i + 1}`, GroupPage, { name: `deep${i + 1}` }),
    ),

    // Single param
    ...Array.from({ length: n(60) }, (_, i) =>
      path(`/r${i + 1}/:id`, GroupPage, { name: `r${i + 1}` }),
    ),

    // Optional param
    ...Array.from({ length: n(40) }, (_, i) =>
      path(`/o${i + 1}/:id?`, GroupPage, { name: `o${i + 1}` }),
    ),

    // Three params
    ...Array.from({ length: n(40) }, (_, i) =>
      path(`/m${i + 1}/:a/:b/:c`, GroupPage, { name: `m${i + 1}` }),
    ),

    // Five params (deep extraction)
    ...Array.from({ length: n(2) }, (_, i) =>
      path(`/w${i + 1}/:a/:b/:c/:d/:e`, GroupPage, { name: `w${i + 1}` }),
    ),

    // Flat static
    ...Array.from({ length: n(30) }, (_, i) =>
      path(`/f/${i + 1}`, GroupPage, { name: `f${i + 1}` }),
    ),

    // Literal-suffix params: longest suffix must win (/x.min.js -> fileMinJs)
    path("/files/:file.js", GroupPage, { name: "fileJs" }),
    path("/files/:file.min.js", GroupPage, { name: "fileMinJs" }),

    // Named catch-alls: one-or-more and zero-or-more
    path("/tree/:rest+", GroupPage, { name: "tree" }),
    path("/blob/:rest*", GroupPage, { name: "blob" }),

    // Group home + marker so the group id is greppable in responses
    path("/", GroupBenchHandler, { name: "home" }),
    path(`/whoami/${groupId}`, GroupBenchHandler, { name: "whoami" }),

    path("/bench/last", GroupBenchHandler, { name: "benchLast" }),
  ]);
}
