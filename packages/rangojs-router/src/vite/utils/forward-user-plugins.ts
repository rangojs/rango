/**
 * Discovery Runner Config Parity
 *
 * The discovery temp server (createTempRscServer) runs the user's handler
 * graph through a throwaway Node Vite server built with `configFile: false`.
 * Without help, that server only sees a fixed Rango-owned plugin set, so any
 * user resolution is absent during discovery, prerender, and static handler
 * rendering — even though it applies at request time. Two flavors of user
 * resolution must be carried across:
 *
 * - Third-party resolveId plugins (e.g. vite-tsconfig-paths) — forwarded as
 *   plugin instances, see selectForwardableResolvePlugins.
 * - Native config-driven resolution, including Vite 8's built-in
 *   `resolve.tsconfigPaths` (which supersedes vite-tsconfig-paths) — forwarded
 *   as the data slice, see pickForwardedRunnerConfig.
 *
 * These helpers extract the resolution-relevant slice of the user's resolved
 * config (resolve.*, define, oxc) and forward the user's resolution plugins
 * into the temp server so discovery resolves modules the same way the real
 * environment does.
 */

import type { Plugin, ResolvedConfig, UserConfig } from "vite";

/**
 * Whether a user plugin must NOT be forwarded into the discovery temp server.
 *
 * Framework-owned plugins are matched precisely -- by exact name or a
 * namespaced prefix -- rather than by a loose substring/word prefix, so an
 * unrelated user resolver named e.g. `rsc-paths` or `cloudflare-kv-alias` is
 * still forwarded (it would otherwise reproduce issue #500).
 *
 * - `vite:*`               Vite core + official plugins (incl.
 *                          @vitejs/plugin-react's `vite:react-*`). The temp
 *                          server already provides its own core; forwarding
 *                          these would duplicate or conflict with it.
 * - `rsc` / `rsc:*`        @vitejs/plugin-rsc. createTempRscServer instantiates
 *                          its own rsc() plugin; forwarding would duplicate it.
 *                          Matched exactly (`rsc`) or by the `rsc:` namespace --
 *                          NOT every `rsc`-prefixed name.
 * - `@rangojs/router*`     Our own plugins. The discovery plugin spawns the
 *                          temp server, so forwarding would recurse infinitely.
 * - `@cloudflare/vite-plugin*` / @cloudflare/vite-plugin (emits the scoped
 *   `vite-plugin-cloudflare*`  `@cloudflare/vite-plugin` and unscoped
 *                          `vite-plugin-cloudflare` / `vite-plugin-cloudflare:*`).
 *                          Forwarding re-inits workerd, defeating the Node temp
 *                          server. Matched specifically so a scoped user resolver
 *                          like `@cloudflare/kv-alias` is still forwarded.
 */
function isDenied(name: string): boolean {
  return (
    name.startsWith("vite:") ||
    name === "rsc" ||
    name.startsWith("rsc:") ||
    name.startsWith("@rangojs/router") ||
    name.startsWith("@cloudflare/vite-plugin") ||
    name.startsWith("vite-plugin-cloudflare")
  );
}

/**
 * A plugin participates in resolution if it exposes `resolveId` or `load`.
 * Plugins that only transform, configure the server, or hook into the build
 * lifecycle do not affect how bare specifiers resolve, so we skip them to keep
 * the forwarded surface minimal.
 */
function hasResolutionHooks(p: Plugin): boolean {
  return Boolean((p as any).resolveId || (p as any).load);
}

/**
 * Strip a resolved plugin instance down to its resolution hooks plus the
 * gating fields that decide whether/where it runs.
 *
 * We reuse the SAME instance objects captured from `config.plugins`. By the
 * time `configResolved` fires on the discovery plugin, every plugin's own
 * `config`/`configResolved` has already run on the main server, so any state
 * a `resolveId` hook depends on (e.g. vite-tsconfig-paths' compiled path
 * matcher, held in closure) is already populated. Forwarding only the
 * resolution hooks therefore preserves correct resolution while avoiding a
 * second `buildStart`/`configureServer`/`config` lifecycle in the temp server.
 *
 * `enforce` and `applyToEnvironment` are preserved so ordering and per-environment
 * gating match the real pipeline.
 *
 * `apply` is intentionally dropped. Vite filters plugins by `apply` against the
 * command during config resolution, so the `config.plugins` we read here is
 * already command-filtered by the main server (build: `apply: "build"` +
 * unconditional; dev: `apply: "serve"` + unconditional). The discovery temp
 * server is always created with `createServer` (`command === "serve"`), so a
 * forwarded `apply: "build"` plugin would be filtered straight back out -- even
 * during a production build, where build-only resolvers are exactly what
 * static/prerender rendering needs. Since the source list is already correct for
 * the current command, the forwarded copy must carry no `apply` gate.
 */
function stripToResolutionHooks(p: Plugin): Plugin {
  const stripped: Plugin = { name: p.name };
  if ((p as any).enforce) (stripped as any).enforce = (p as any).enforce;
  if ((p as any).applyToEnvironment)
    (stripped as any).applyToEnvironment = (p as any).applyToEnvironment;
  if ((p as any).resolveId) (stripped as any).resolveId = (p as any).resolveId;
  if ((p as any).load) (stripped as any).load = (p as any).load;
  return stripped;
}

/**
 * Pick the user's resolution plugins from the resolved plugin list, denylist
 * framework-owned plugins, keep only those with resolution hooks, and strip
 * each to its resolution surface. Returns plugin objects safe to drop into the
 * discovery temp server's `plugins` array.
 */
export function selectForwardableResolvePlugins(
  plugins: readonly Plugin[] | undefined,
): Plugin[] {
  if (!plugins) return [];
  const forwarded: Plugin[] = [];
  for (const p of plugins) {
    const name = p?.name;
    if (!name || isDenied(name)) continue;
    if (!hasResolutionHooks(p)) continue;
    forwarded.push(stripToResolutionHooks(p));
  }
  return forwarded;
}

/**
 * The resolution-relevant slice of the user's resolved config that is plain
 * data (no plugin re-execution): everything under `resolve` that influences
 * how specifiers map to files, plus `define` and `oxc` so transforms and
 * compile-time constants match request time.
 */
export interface ForwardedRunnerConfig {
  resolve: UserConfig["resolve"];
  define: UserConfig["define"];
  oxc: UserConfig["oxc"];
}

/**
 * Extract the data-only config slice to mirror into the discovery temp server.
 * `alias` is included here so callers no longer need to thread it separately.
 *
 * `tsconfigPaths` is forwarded so Vite 8's native tsconfig `paths` resolution
 * (a top-level `resolve` flag, off by default) reaches the temp server. The
 * server is created with `configFile: false` and an explicit, allowlisted
 * resolve slice, so a flag that is not copied here is simply absent during
 * discovery — which would make path-aliased imports fail at prerender/static
 * time the same way unforwarded resolveId plugins did (issue #500).
 *
 * `oxc` keeps the user's options but always pins the RSC-required JSX runtime
 * (automatic, react), since the temp server compiles the handler graph as
 * React server components regardless of the user's app-level JSX config. Vite 8
 * replaced the deprecated `esbuild` transform option with `oxc`, so we read and
 * forward `oxc` exclusively — no `esbuild` field is touched.
 */
export function pickForwardedRunnerConfig(
  config: ResolvedConfig,
): ForwardedRunnerConfig {
  const r = config.resolve ?? ({} as ResolvedConfig["resolve"]);
  const resolve: NonNullable<UserConfig["resolve"]> = {};
  if (r.alias !== undefined) resolve.alias = r.alias as any;
  if (r.dedupe !== undefined) resolve.dedupe = r.dedupe;
  if (r.conditions !== undefined) resolve.conditions = r.conditions;
  if (r.mainFields !== undefined) resolve.mainFields = r.mainFields;
  if (r.extensions !== undefined) resolve.extensions = r.extensions;
  if (r.preserveSymlinks !== undefined)
    resolve.preserveSymlinks = r.preserveSymlinks;
  if (r.tsconfigPaths !== undefined) resolve.tsconfigPaths = r.tsconfigPaths;

  // Pin the RSC JSX runtime on top of the user's oxc options. The user's
  // jsx sub-options (e.g. `development`) are preserved when present; only
  // `runtime`/`importSource` are forced to the values the RSC compile needs.
  const userOxc = config.oxc;
  const userJsx =
    userOxc &&
    typeof userOxc === "object" &&
    typeof userOxc.jsx === "object" &&
    userOxc.jsx !== null
      ? userOxc.jsx
      : {};
  const oxc: UserConfig["oxc"] =
    userOxc && typeof userOxc === "object"
      ? {
          ...userOxc,
          jsx: { ...userJsx, runtime: "automatic", importSource: "react" },
        }
      : { jsx: { runtime: "automatic", importSource: "react" } };

  return {
    resolve,
    define: config.define,
    oxc,
  };
}
