/**
 * Build-time env (rango({ buildEnv })): resolution of the option and the
 * lifetime of the resolved bindings on DiscoveryState. Acquired by dev
 * discovery (dev-server-phase.ts) and build discovery
 * (build-discovery-phase.ts).
 */

import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { BUILD_ENV_GLOBAL_KEY } from "../plugins/cloudflare-protocol-stub.js";
import type {
  BuildEnvOption,
  BuildEnvFactoryContext,
  BuildEnvResult,
} from "../plugin-types.js";
import type { DiscoveryState } from "./state.js";

const WRANGLER_CONFIG_NAMES: readonly string[] = [
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
];

/**
 * getPlatformProxy() looks for the wrangler config from process.cwd() and
 * resolves its default persist path against cwd, so building from another
 * directory dropped the app's bindings (#1037). Search upward from the Vite
 * root with wrangler's own file names and order. Persisted state goes under
 * the Vite root, where @cloudflare/vite-plugin reads it in dev and preview
 * (its getPersistenceRoot), also when the config sits above the root. No
 * config found: no options, wrangler's own lookup.
 */
function wranglerProxyOptions(
  root: string,
): Record<string, unknown> | undefined {
  const viteRoot = resolve(root);
  for (let dir = viteRoot; ; dir = dirname(dir)) {
    for (const name of WRANGLER_CONFIG_NAMES) {
      const configPath = join(dir, name);
      if (existsSync(configPath)) {
        return {
          configPath,
          persist: { path: join(viteRoot, ".wrangler", "state", "v3") },
        };
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Resolve the buildEnv option into a concrete { env, dispose? } result.
 * Handles all four input shapes: false, "auto", factory, plain object.
 */
export async function resolveBuildEnv(
  option: BuildEnvOption | undefined,
  factoryCtx: BuildEnvFactoryContext,
): Promise<BuildEnvResult | null> {
  if (!option) return null;

  if (option === "auto") {
    if (factoryCtx.preset !== "cloudflare") {
      throw new Error(
        '[rango] buildEnv: "auto" is only supported with preset: "cloudflare". ' +
          "Use a factory function or plain object for other presets.",
      );
    }
    try {
      // Resolve wrangler from the user's project root (not the router package)
      const userRequire = createRequire(
        resolve(factoryCtx.root, "package.json"),
      );
      const wranglerPath = userRequire.resolve("wrangler");
      const { getPlatformProxy } = (await import(
        pathToFileURL(wranglerPath).href
      )) as {
        getPlatformProxy: (opts?: any) => Promise<any>;
      };
      const proxy = await getPlatformProxy(
        wranglerProxyOptions(factoryCtx.root),
      );
      return {
        env: proxy.env as Record<string, unknown>,
        dispose: proxy.dispose,
      };
    } catch (err: any) {
      throw new Error(
        '[rango] buildEnv: "auto" requires wrangler to be installed.\n' +
          `Install it with: pnpm add -D wrangler\n${err.message}`,
      );
    }
  }

  if (typeof option === "function") {
    return await option(factoryCtx);
  }

  // Plain object
  return { env: option };
}

/**
 * Acquire build-time env bindings and store on discovery state.
 * Returns true if env was acquired, false if buildEnv is disabled.
 */
export async function acquireBuildEnv(
  s: DiscoveryState,
  command: "serve" | "build",
  mode: string,
): Promise<boolean> {
  const option = s.opts?.buildEnv;
  if (!option) return false;

  const result = await resolveBuildEnv(option, {
    root: s.projectRoot,
    mode,
    command,
    preset: s.opts?.preset ?? "node",
  });
  if (!result) return false;

  s.resolvedBuildEnv = result.env;
  s.buildEnvDispose = result.dispose ?? null;
  // Bridge the resolved env into `cloudflare:workers`'s stubbed `env`
  // export so user code that does `import { env } from "cloudflare:workers"`
  // sees the real bindings proxy during discovery + prerender instead of
  // an empty object. The stub reads this global at module-evaluation time.
  (globalThis as Record<string, unknown>)[BUILD_ENV_GLOBAL_KEY] = result.env;
  return true;
}

/**
 * Release build-time env resources and clear state.
 */
export async function releaseBuildEnv(s: DiscoveryState): Promise<void> {
  if (s.buildEnvDispose) {
    try {
      await s.buildEnvDispose();
    } catch (err: any) {
      console.warn(`[rango] buildEnv dispose failed: ${err.message}`);
    }
    s.buildEnvDispose = null;
  }
  s.resolvedBuildEnv = undefined;
  delete (globalThis as Record<string, unknown>)[BUILD_ENV_GLOBAL_KEY];
}
