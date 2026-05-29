import { join } from "node:path";
import type { PluginOption, Plugin } from "vite";
import { visualizer } from "rollup-plugin-visualizer";

const ENVIRONMENTS = ["client", "ssr", "rsc"] as const;

/**
 * Adds rollup-plugin-visualizer per Vite environment when RANGO_ANALYZE=1.
 *
 * Per environment, emits both an HTML treemap (humans) and a raw-data JSON
 * dump (the machine-readable input for `tools/bundle-report.mjs`):
 *
 *   <projectRoot>/bundle-stats/<env>.html
 *   <projectRoot>/bundle-stats/<env>.json
 *
 * Note: visualizer's function-form options cache after the first call, so a
 * single plugin instance can't handle multi-output builds. We register a
 * separate instance per environment, each scoped via applyToEnvironment.
 *
 * Returns [] when the env var is unset so production builds are unaffected.
 */
export function analyze(): PluginOption[] {
  if (!process.env.RANGO_ANALYZE) return [];
  return ENVIRONMENTS.flatMap((envName) =>
    (
      [
        { template: "treemap", ext: "html" },
        { template: "raw-data", ext: "json" },
      ] as const
    ).map(({ template, ext }) => {
      const inner = visualizer({
        filename: join("bundle-stats", `${envName}.${ext}`),
        template,
        gzipSize: true,
        brotliSize: true,
      }) as Plugin;
      return {
        ...inner,
        name: `analyze-${envName}-${template}`,
        applyToEnvironment(environment) {
          return environment.name === envName;
        },
      } as Plugin;
    }),
  );
}
