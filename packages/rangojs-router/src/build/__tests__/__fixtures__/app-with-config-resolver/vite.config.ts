import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { rango } from "@rangojs/router/vite";

// The test moves this file to the project root, one level above the fixture.
const FIXTURE_DIR = "app-with-config-resolver";
const PREFIX = "@config-resolved/";

/**
 * Builds its matcher in configResolved, as vite-tsconfig-paths does: until
 * that hook runs it resolves nothing.
 */
function configResolvedResolver(): Plugin {
  let baseDir: string | undefined;
  return {
    name: "test-config-resolved-resolver",
    enforce: "pre",
    configResolved(config) {
      baseDir = join(config.root, FIXTURE_DIR);
    },
    resolveId(id, importer, options) {
      if (!baseDir || !id.startsWith(PREFIX)) return null;
      return this.resolve(join(baseDir, id.slice(PREFIX.length)), importer, {
        skipSelf: true,
        ...options,
      });
    },
  };
}

/** Resolves the same specifier elsewhere, for `vite build` only. */
function buildOnlyResolver(): Plugin {
  const target = fileURLToPath(
    new URL(`./${FIXTURE_DIR}/build-only-marker.ts`, import.meta.url),
  );
  return {
    name: "test-build-only-resolver",
    apply: "build",
    enforce: "pre",
    resolveId(id) {
      return id === `${PREFIX}marker` ? target : null;
    },
  };
}

export default {
  plugins: [buildOnlyResolver(), configResolvedResolver(), rango()],
};
