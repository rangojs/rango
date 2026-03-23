import { describe, expect, it } from "vitest";
import { rango } from "../rango.js";

const RSDW_CLIENT_BROWSER_EXCLUDE =
  "@vitejs/plugin-rsc/vendor/react-server-dom/client.browser";
const RSC_BROWSER_ENTRY_EXCLUDE = "@vitejs/plugin-rsc/browser";
const PERF_OPTIMIZE_PLUGIN = "@rangojs/router:performance-tracks-optimize-deps";
const PERF_VITE_PLUGIN = "@rangojs/router:performance-tracks";

describe("rango optimizeDeps config", () => {
  it("excludes the browser RSDW client from node client prebundling", async () => {
    const plugins = (await rango({ banner: false })) as any[];
    const integration = plugins.find(
      (plugin) => plugin?.name === "@rangojs/router:rsc-integration",
    );
    const perfPlugin = plugins.find(
      (plugin) => plugin?.name === PERF_VITE_PLUGIN,
    );

    expect(integration).toBeTruthy();
    expect(perfPlugin).toBeTruthy();

    const config = integration.config();
    expect(config.optimizeDeps.exclude).toContain(RSC_BROWSER_ENTRY_EXCLUDE);
    expect(config.optimizeDeps.exclude).toContain(RSDW_CLIENT_BROWSER_EXCLUDE);
    expect(config.environments.client.optimizeDeps.exclude).toContain(
      RSC_BROWSER_ENTRY_EXCLUDE,
    );
    expect(config.environments.client.optimizeDeps.exclude).toContain(
      RSDW_CLIENT_BROWSER_EXCLUDE,
    );
    expect(
      config.environments.client.optimizeDeps.esbuildOptions.plugins.map(
        (plugin: any) => plugin.name,
      ),
    ).toContain(PERF_OPTIMIZE_PLUGIN);
  });

  it("excludes the browser RSDW client from cloudflare client prebundling", async () => {
    const plugins = (await rango({
      preset: "cloudflare",
      banner: false,
    })) as any[];
    const integration = plugins.find(
      (plugin) => plugin?.name === "@rangojs/router:cloudflare-integration",
    );
    const perfPlugin = plugins.find(
      (plugin) => plugin?.name === PERF_VITE_PLUGIN,
    );

    expect(integration).toBeTruthy();
    expect(perfPlugin).toBeTruthy();

    const config = integration.config();
    expect(config.optimizeDeps.exclude).toContain(RSC_BROWSER_ENTRY_EXCLUDE);
    expect(config.optimizeDeps.exclude).toContain(RSDW_CLIENT_BROWSER_EXCLUDE);
    expect(config.environments.client.optimizeDeps.exclude).toContain(
      RSC_BROWSER_ENTRY_EXCLUDE,
    );
    expect(config.environments.client.optimizeDeps.exclude).toContain(
      RSDW_CLIENT_BROWSER_EXCLUDE,
    );
    expect(
      config.environments.client.optimizeDeps.esbuildOptions.plugins.map(
        (plugin: any) => plugin.name,
      ),
    ).toContain(PERF_OPTIMIZE_PLUGIN);
  });
});
