import { join } from "node:path";
import type { PluginOption, Plugin } from "vite";
import { visualizer } from "rollup-plugin-visualizer";

const ENVIRONMENTS = ["client", "ssr", "rsc"] as const;

/**
 * Adds rollup-plugin-visualizer per Vite environment when RANGO_ANALYZE=1.
 *
 * Emits one HTML treemap per environment to `<projectRoot>/bundle-stats/<env>.html`.
 *
 * Note: visualizer's function-form options cache after the first call, so a
 * single plugin instance can't handle multi-output builds. We register a
 * separate instance per environment, each scoped via applyToEnvironment.
 *
 * Returns [] when the env var is unset so production builds are unaffected.
 */
export function analyze(): PluginOption[] {
  if (!process.env.RANGO_ANALYZE) return [];
  return ENVIRONMENTS.map((envName) => {
    const inner = visualizer({
      filename: join("bundle-stats", `${envName}.html`),
      template: "treemap",
      gzipSize: true,
      brotliSize: true,
    }) as Plugin;
    return {
      ...inner,
      name: `analyze-${envName}`,
      applyToEnvironment(environment) {
        return environment.name === envName;
      },
    } as Plugin;
  });
}
