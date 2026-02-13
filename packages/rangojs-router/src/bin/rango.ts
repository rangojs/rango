import { resolve, dirname, basename, join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  findTsFiles,
  findRouterFiles,
  writePerModuleRouteTypesForFile,
  writeCombinedRouteTypes,
  generateRouteTypesSource,
} from "../build/generate-route-types.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "extract-names") {
  const staticOnly = args.includes("--static-only");
  const positionalArgs = args.filter((a) => !a.startsWith("--"));
  const dir = positionalArgs[0] ?? "./src";
  const resolvedDir = resolve(dir);
  const projectRoot = resolve(".");

  extractNames(resolvedDir, projectRoot, staticOnly)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[rango] Fatal error:`, err.message || err);
      process.exit(1);
    });
} else {
  console.log(`Usage: rango <command>

Commands:
  extract-names [dir]  Extract route names from url modules (default: ./src)

Options:
  --static-only        Skip Vite runtime discovery, use static parsing only`);
  process.exit(command ? 1 : 0);
}

async function extractNames(
  resolvedDir: string,
  projectRoot: string,
  staticOnly: boolean,
): Promise<void> {
  // Always generate per-module .gen.ts via static parsing
  console.log(`[rango] Scanning ${resolvedDir} for url modules...`);
  const files = findTsFiles(resolvedDir);
  for (const filePath of files) {
    writePerModuleRouteTypesForFile(filePath);
  }

  // Always generate combined named-routes.gen.ts via static parsing first.
  // This is required even before runtime discovery because the exposeRouterId
  // plugin injects `import ... from "./router.named-routes.gen.js"` into router
  // files. Without a seed file, the temp server import will fail.
  writeCombinedRouteTypes(resolvedDir);

  if (staticOnly) {
    console.log(`[rango] Scanned ${files.length} file(s) (static only)`);
    return;
  }

  // Try runtime discovery via Vite module runner.
  // On success this overwrites the static gen files with the complete set
  // (including dynamically generated routes).
  const used = await tryRuntimeDiscovery(resolvedDir, projectRoot);
  if (!used) {
    console.log(`[rango] Scanned ${files.length} file(s) (static fallback)`);
  }
}

async function tryRuntimeDiscovery(
  resolvedDir: string,
  projectRoot: string,
): Promise<boolean> {
  // Check if Vite is available
  try {
    await import("vite");
  } catch {
    console.log(`[rango] Vite not available, falling back to static parsing`);
    return false;
  }

  // Find router entry files
  const routerFiles = findRouterFiles(resolvedDir);

  if (routerFiles.length === 0) {
    console.log(`[rango] No router files found, falling back to static parsing`);
    return false;
  }

  if (routerFiles.length > 1) {
    console.error(
      `[rango] Found ${routerFiles.length} router files, expected 1:\n` +
      routerFiles.map((f) => `  - ${f}`).join("\n") +
      `\nPass the specific router file as the dir argument.`
    );
    return false;
  }

  const entryPath = routerFiles[0];
  console.log(`[rango] Discovering routes via Vite runtime (${entryPath})...`);

  try {
    const { discoverRoutesViaRunner } = await import("../vite/discover.ts");

    const routers = await discoverRoutesViaRunner({
      entryPath,
      projectRoot,
    });

    if (routers.length === 0) {
      console.log(`[rango] Runtime discovery found no routers, falling back to static parsing`);
      return false;
    }

    let totalRoutes = 0;

    for (const router of routers) {
      const routeCount = Object.keys(router.routeManifest).length;
      totalRoutes += routeCount;

      // Determine output path from sourceFile or entry
      const sourceFile = router.sourceFile || entryPath;
      const routerDir = dirname(sourceFile);
      const routerBasename = basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
      const outPath = join(routerDir, `${routerBasename}.named-routes.gen.ts`);

      const source = generateRouteTypesSource(router.routeManifest);
      const existing = existsSync(outPath) ? readFileSync(outPath, "utf-8") : null;

      if (existing !== source) {
        writeFileSync(outPath, source);
        console.log(
          `[rango] Generated route types (${routeCount} routes) -> ${outPath}`
        );
      } else {
        console.log(
          `[rango] Route types unchanged (${routeCount} routes) -> ${outPath}`
        );
      }
    }

    console.log(
      `[rango] Runtime discovery complete: ${routers.length} router(s), ${totalRoutes} route(s)`
    );
    return true;
  } catch (err: any) {
    console.warn(
      `[rango] Runtime discovery failed, falling back to static parsing: ${err.message || err}`
    );
    return false;
  }
}
