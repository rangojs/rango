import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveConfig, type ResolvedConfig } from "vite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rango } from "../rango";

/**
 * Issue #1050: plugin-rsc injects `@vitejs/plugin-rsc/vendor/...` entries into
 * every environment's optimizeDeps.include, and Vite resolves them from the
 * project root. A strict-pnpm app that installs only @rangojs/router does not
 * have plugin-rsc there, so each entry must be reachable through
 * resolve.alias (absolute path resolved from this package).
 */

const PLUGIN_RSC_PREFIX = "@vitejs/plugin-rsc/";
const ENVIRONMENTS = ["client", "ssr", "rsc"] as const;
const require = createRequire(import.meta.url);

async function resolveRangoConfig(
  preset: "node" | "cloudflare",
  root: string,
): Promise<ResolvedConfig> {
  const plugins = await rango({ preset, banner: false });
  return resolveConfig(
    { root, configFile: false, plugins, logLevel: "silent" },
    "serve",
  );
}

function aliasTarget(config: ResolvedConfig, spec: string): string | undefined {
  const aliases = config.resolve.alias as {
    find: unknown;
    replacement: string;
  }[];
  return aliases.find((a) => a.find === spec)?.replacement;
}

function pluginRscIncludes(config: ResolvedConfig): [string, string][] {
  const found: [string, string][] = [];
  for (const env of ENVIRONMENTS) {
    const include: string[] =
      (config.environments as Record<string, any>)[env].optimizeDeps.include ??
      [];
    for (const spec of include) {
      if (spec.startsWith(PLUGIN_RSC_PREFIX)) found.push([env, spec]);
    }
  }
  return found;
}

describe("plugin-rsc vendor optimizeDeps.include entries", () => {
  let bareRoot: string;
  let linkedRoot: string;

  beforeAll(() => {
    bareRoot = mkdtempSync(join(tmpdir(), "rango-vendor-bare-"));
    linkedRoot = mkdtempSync(join(tmpdir(), "rango-vendor-linked-"));
    const pluginRscDir = dirname(
      require.resolve("@vitejs/plugin-rsc/package.json"),
    );
    mkdirSync(join(linkedRoot, "node_modules", "@vitejs"), { recursive: true });
    symlinkSync(
      pluginRscDir,
      join(linkedRoot, "node_modules", "@vitejs", "plugin-rsc"),
    );
  });

  afterAll(() => {
    rmSync(bareRoot, { recursive: true, force: true });
    rmSync(linkedRoot, { recursive: true, force: true });
  });

  for (const preset of ["node", "cloudflare"] as const) {
    it(`${preset}: every entry resolves when plugin-rsc is not in the project root`, async () => {
      const config = await resolveRangoConfig(preset, bareRoot);
      const entries = pluginRscIncludes(config);
      expect(entries.length).toBeGreaterThan(0);

      for (const [env, spec] of entries) {
        const target = aliasTarget(config, spec);
        expect(target, `${preset}/${env}: no alias for ${spec}`).toBeTruthy();
        expect(existsSync(target!), `${preset}/${env}: ${target}`).toBe(true);
      }
    });

    it(`${preset}: aliases point at the module the root's own plugin-rsc would resolve`, async () => {
      const config = await resolveRangoConfig(preset, linkedRoot);
      const rootRequire = createRequire(join(linkedRoot, "package.json"));

      for (const [env, spec] of pluginRscIncludes(config)) {
        const target = aliasTarget(config, spec);
        expect(target, `${preset}/${env}: no alias for ${spec}`).toBeTruthy();
        expect(realpathSync(target!)).toBe(
          realpathSync(rootRequire.resolve(spec)),
        );
      }
    });
  }
});
