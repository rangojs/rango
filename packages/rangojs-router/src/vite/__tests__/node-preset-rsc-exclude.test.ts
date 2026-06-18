import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveConfig, type ResolvedConfig } from "vite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rango } from "../rango";

// E6: Vite 8 does not propagate the top-level optimizeDeps.exclude (set in
// rango's config() hook) to non-client environments. The node preset's rsc env
// must therefore set `exclude: excludeDeps` explicitly — mirroring the node ssr
// env and the cloudflare rsc env. Without it, the rsc optimizer can try to
// pre-bundle the router's own subpath entries in a strict-pnpm npm app.

async function resolveNodeConfig(
  command: "serve" | "build",
  root: string,
): Promise<ResolvedConfig> {
  const plugins = await rango({ preset: "node", banner: false });
  return resolveConfig(
    { root, configFile: false, plugins, logLevel: "silent" },
    command,
  );
}

describe("node preset rsc env optimizeDeps.exclude (E6)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rango-e6-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Both dev (serve) and production (build): the exclude is not
  // command-conditional, so both must carry it.
  for (const command of ["serve", "build"] as const) {
    it(`(${command}) rsc env excludes the router package, matching the ssr env`, async () => {
      const config = await resolveNodeConfig(command, root);
      const rscExclude = (config.environments as Record<string, any>)?.rsc
        ?.optimizeDeps?.exclude as string[] | undefined;
      const ssrExclude = (config.environments as Record<string, any>)?.ssr
        ?.optimizeDeps?.exclude as string[] | undefined;

      // The ssr env already carries the exclude (the reference).
      expect(ssrExclude).toEqual(expect.arrayContaining(["@rangojs/router"]));
      // The rsc env must carry the SAME exclude — this is the fix.
      expect(rscExclude).toEqual(expect.arrayContaining(["@rangojs/router"]));
      // It also excludes the router's own subpath entries (the failure mode).
      expect(rscExclude).toEqual(
        expect.arrayContaining([
          "@rangojs/router/server",
          "@rangojs/router/rsc",
        ]),
      );
    });
  }
});
