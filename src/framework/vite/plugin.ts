// vite-plugin-rsc-router.js
import { glob } from "glob";
import path from "path";
import { normalizePath } from "vite";

export function rscRouter(options = {}) {
  console.log("rscRouter options", options);
  const {
    routesPath = "./src/routes",
    patterns = {
      include: ["**/*.{js,jsx,ts,tsx}"],
      exclude: ["**/*.test.*", "**/*.spec.*", "**/components/**"],
    },
    eager = false,
    // Specify which environments should have access
    environments = ["rsc"],
  } = options;

  const virtualModuleId = "virtual:rsc-router";
  const resolvedVirtualModuleId = "\0" + virtualModuleId;

  // Store generated code to share across environments
  let generatedCode = null;
  let lastGenerated = 0;

  async function generateModuleCode() {
    const now = Date.now();
    // Cache for 100ms to avoid regenerating for each environment
    if (generatedCode && now - lastGenerated < 100) {
      return generatedCode;
    }

    const routesDir = path.resolve(process.cwd(), routesPath);

    const files = await glob(patterns.include, {
      cwd: routesDir,
      ignore: patterns.exclude,
      absolute: false,
    });

    const imports = [];
    const moduleMap = {};

    files.forEach((file, index) => {
      const importPath = normalizePath(path.join(routesDir, file));
      const key = file.replace(/\.(js|jsx|ts|tsx)$/, "");
      const varName = `route_${index}`;

      if (eager) {
        imports.push(`import * as ${varName} from '${importPath}';`);
        moduleMap[key] = varName;
      } else {
        moduleMap[key] = `() => import('${importPath}')`;
      }
    });

    const buildNestedStructure = () => {
      const structure = {};

      Object.entries(moduleMap).forEach(([filePath, importRef]) => {
        const parts = filePath.split("/");
        let current = structure;

        parts.forEach((part, i) => {
          if (i === parts.length - 1) {
            current[part] = eager ? importRef : `${importRef}`;
          } else {
            current[part] = current[part] || {};
            current = current[part];
          }
        });
      });
      console.log("structure", structure);

      return structure;
    };

    if (eager) {
      generatedCode = `
${imports.join("\n")}

const modules = {
${Object.entries(moduleMap)
  .map(([key, varName]) => `  '${key}': ${varName}`)
  .join(",\n")}
};

const structure = ${JSON.stringify(buildNestedStructure())
        .replace(/"([^"]+)":/g, "$1:")
        .replace(/:"route_(\d+)"/g, ":route_$1")};

export { modules, structure };
export default modules;
`;
    } else {
      generatedCode = `
const modules = {
${Object.entries(moduleMap)
  .map(([key, loader]) => `  '${key}': ${loader}`)
  .join(",\n")}
};

const structure = "";

export { modules, structure };
export default modules;
`;
    }

    lastGenerated = now;
    return generatedCode;
  }

  return {
    name: "vite-plugin-rsc-router",

    // Support for environment-specific resolution
    resolveId: {
      order: "pre",
      async handler(id, importer, options) {
        if (id === virtualModuleId) {
          // Check if current environment should have access
          const environment =
            options?.environment || this.environment?.name || "client";

          if (environments.includes(environment)) {
            return {
              id: resolvedVirtualModuleId,
              // Mark as virtual module
              virtual: true,
              // Ensure it's not externalized in SSR/RSC
              external: false,
              // Module side effects
              moduleSideEffects: false,
            };
          }
        }
        return null;
      },
    },

    load: {
      order: "pre",
      async handler(id, options) {
        if (id === resolvedVirtualModuleId) {
          const environment =
            options?.environment || this.environment?.name || "client";

          // Generate environment-specific code if needed
          if (environments.includes(environment)) {
            const code = await generateModuleCode();

            // You can customize the code per environment
            if (environment === "rsc") {
              // RSC-specific modifications
              return {
                code,
                map: null,
                // Mark module as having no side effects for better tree-shaking
                moduleSideEffects: false,
              };
            }

            return {
              code,
              map: null,
            };
          }
        }
        return null;
      },
    },

    // Handle HMR and file watching
    configureServer(server) {
      const routesDir = path.resolve(process.cwd(), routesPath);

      server.watcher.add(routesDir);

      const reloadVirtualModule = async () => {
        // Clear cache
        generatedCode = null;

        // Invalidate in all environments
        if (server.environments) {
          for (const envName of environments) {
            const env = server.environments[envName];
            if (env) {
              const module = env.moduleGraph.getModuleById(
                resolvedVirtualModuleId
              );
              if (module) {
                env.moduleGraph.invalidateModule(module);
              }
            }
          }
        } else {
          // Fallback for older Vite versions
          const module = server.moduleGraph.getModuleById(
            resolvedVirtualModuleId
          );
          if (module) {
            server.moduleGraph.invalidateModule(module);
          }
        }

        server.ws.send({
          type: "full-reload",
          path: "*",
        });
      };

      server.watcher.on("add", (file) => {
        if (file.startsWith(routesDir)) reloadVirtualModule();
      });

      server.watcher.on("unlink", (file) => {
        if (file.startsWith(routesDir)) reloadVirtualModule();
      });

      server.watcher.on("change", (file) => {
        if (file.startsWith(routesDir)) reloadVirtualModule();
      });
    },

    // For build-time environment configuration
    config(config, { environment }) {
      // You can modify config based on environment
      if (environment?.name === "rsc") {
        // RSC-specific config modifications
      }
    },
  };
}
