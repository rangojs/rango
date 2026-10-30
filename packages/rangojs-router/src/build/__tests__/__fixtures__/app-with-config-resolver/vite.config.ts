import { join } from "node:path";
import { rango } from "@rangojs/router/vite";

// Builds its alias table in configResolved, as vite-tsconfig-paths builds its
// path matchers: without that hook it resolves nothing.
function configResolvedAlias() {
  let routesDir: string | undefined;
  return {
    name: "config-resolved-alias",
    configResolved(config: { root: string }) {
      routesDir = join(config.root, "routes");
    },
    resolveId(id: string) {
      if (!routesDir || !id.startsWith("~routes/")) return null;
      return join(routesDir, `${id.slice("~routes/".length)}.tsx`);
    },
  };
}

// Vite leaves it out of a serve run, which a --runtime discovery is.
function buildOnlyResolver() {
  return {
    name: "build-only-resolver",
    apply: "build" as const,
    enforce: "pre" as const,
    resolveId(id: string) {
      if (id.startsWith("~routes/")) {
        throw new Error("build-only resolver ran in a serve discovery");
      }
      return null;
    },
  };
}

export default {
  plugins: [rango(), configResolvedAlias(), buildOnlyResolver()],
};
