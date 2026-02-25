import { resolve, dirname } from "node:path";
import { readFileSync, statSync, existsSync } from "node:fs";
import {
  findTsFiles,
  writePerModuleRouteTypesForFile,
  writeCombinedRouteTypes,
  detectUnresolvableIncludes,
  type UnresolvableInclude,
} from "../build/generate-route-types.ts";

const [command, ...rawArgs] = process.argv.slice(2);

if (command === "generate") {
  // Parse flags
  let mode: "default" | "runtime" | "static" = "default";
  let configFile: string | undefined;
  const positionalArgs: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--runtime") {
      mode = "runtime";
    } else if (arg === "--static") {
      mode = "static";
    } else if (arg === "--config") {
      configFile = rawArgs[++i];
      if (!configFile) {
        console.error("[rango] --config requires a path argument");
        process.exit(1);
      }
    } else if (arg.startsWith("--")) {
      console.error(`[rango] Unknown flag: ${arg}`);
      process.exit(1);
    } else {
      positionalArgs.push(arg);
    }
  }

  if (positionalArgs.length === 0) {
    console.error(
      "[rango] Usage: rango generate <file|dir> [file2 ...] [--runtime|--static] [--config <path>]",
    );
    process.exit(1);
  }

  if (configFile && mode !== "runtime") {
    console.warn("[rango] --config is only used with --runtime, ignoring");
  }

  if (mode === "runtime") {
    // Runtime discovery: dynamically import to avoid loading Vite for static-only usage
    runRuntimeDiscovery(positionalArgs, configFile).catch((err) => {
      console.error(`[rango] Runtime discovery failed: ${err.message}`);
      process.exit(1);
    });
  } else {
    runStaticGeneration(positionalArgs, mode);
  }
} else {
  if (
    command &&
    command !== "help" &&
    command !== "--help" &&
    command !== "-h"
  ) {
    console.error(`[rango] Unknown command: ${command}\n`);
  }
  console.log(`Usage: rango generate <file|dir> [file2 ...] [--runtime|--static] [--config <path>]

  Auto-detects file type (createRouter, urls) and generates
  the appropriate .gen.ts route type files.

Modes:
  (default)   Static parser with error on unresolvable includes
  --runtime   Vite-based runtime discovery (100% coverage)
              Requires vite and @vitejs/plugin-rsc
  --static    Static parser, accept partial output with warnings

Options:
  --config <path>  Path to vite.config.ts (--runtime only, auto-detected if omitted)

Examples:
  rango generate src/router.tsx
  rango generate src/router.tsx --runtime
  rango generate src/ --static`);
  process.exit(
    command && command !== "help" && command !== "--help" && command !== "-h"
      ? 1
      : 0,
  );
}

/**
 * Walk up from a file path to find the project root (directory containing
 * package.json or vite.config.ts).
 */
function findProjectRoot(fromPath: string): string {
  let dir = dirname(resolve(fromPath));
  while (dir !== dirname(dir)) {
    if (
      existsSync(resolve(dir, "package.json")) ||
      existsSync(resolve(dir, "vite.config.ts")) ||
      existsSync(resolve(dir, "vite.config.js"))
    ) {
      return dir;
    }
    dir = dirname(dir);
  }
  // Fallback to cwd if no project root found
  return process.cwd();
}

function runStaticGeneration(args: string[], mode: "default" | "static") {
  // Expand args: files are used directly, directories are scanned
  const files: string[] = [];
  for (const arg of args) {
    const resolved = resolve(arg);
    try {
      if (statSync(resolved).isDirectory()) {
        files.push(...findTsFiles(resolved));
      } else {
        files.push(resolved);
      }
    } catch {
      console.warn(`[rango] Skipping ${arg}: not found`);
    }
  }

  if (files.length === 0) {
    console.log("[rango] No files to process");
    process.exit(0);
  }

  const routerFiles: string[] = [];

  for (const filePath of files) {
    try {
      const source = readFileSync(filePath, "utf-8");

      // Detect file type and generate accordingly
      const isRouter = /\bcreateRouter\s*[<(]/.test(source);
      const isUrls = source.includes("urls(");

      if (isRouter) {
        routerFiles.push(filePath);
      }

      if (isUrls) {
        writePerModuleRouteTypesForFile(filePath);
      }
    } catch (err) {
      console.warn(
        `[rango] Failed to process ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  // Check for unresolvable includes across all router files
  const allDiagnostics: Array<UnresolvableInclude & { routerFile: string }> =
    [];
  for (const routerFile of routerFiles) {
    const diagnostics = detectUnresolvableIncludes(routerFile);
    for (const d of diagnostics) {
      allDiagnostics.push({ ...d, routerFile });
    }
  }

  if (allDiagnostics.length > 0 && mode === "default") {
    // Hard error: unresolvable includes detected
    console.error("\n[rango] Unresolvable includes detected:\n");
    formatDiagnostics(allDiagnostics);
    console.error(
      "\nThe static parser cannot resolve these includes because they use " +
        "factory functions or dynamic expressions.\n\n" +
        "Options:\n" +
        "  rango generate <path> --runtime   Use Vite-based discovery (requires vite)\n" +
        "  rango generate <path> --static    Accept partial output (missing routes above)\n",
    );
    process.exit(1);
  }

  if (allDiagnostics.length > 0 && mode === "static") {
    // Warning: partial output accepted
    console.warn(
      "\n[rango] Warning: partial output (unresolvable includes):\n",
    );
    formatDiagnostics(allDiagnostics);
    console.warn("");
  }

  // Generate named-routes for any detected router files
  for (const routerFile of routerFiles) {
    const projectRoot = findProjectRoot(routerFile);
    writeCombinedRouteTypes(projectRoot, [routerFile]);
  }

  console.log(
    `[rango] Processed ${files.length} file(s)${routerFiles.length ? ` (${routerFiles.length} router)` : ""}`,
  );
  process.exit(0);
}

async function runRuntimeDiscovery(args: string[], configFile?: string) {
  // Resolve the entry: find the router file from the arguments
  const files: string[] = [];
  for (const arg of args) {
    const resolved = resolve(arg);
    try {
      if (statSync(resolved).isDirectory()) {
        files.push(...findTsFiles(resolved));
      } else {
        files.push(resolved);
      }
    } catch {
      console.warn(`[rango] Skipping ${arg}: not found`);
    }
  }

  // Find router files among the inputs
  const routerEntries: string[] = [];
  for (const filePath of files) {
    try {
      const source = readFileSync(filePath, "utf-8");
      if (/\bcreateRouter\s*[<(]/.test(source)) {
        routerEntries.push(filePath);
      }
      // Also generate per-module types for urls files
      if (source.includes("urls(")) {
        writePerModuleRouteTypesForFile(filePath);
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (routerEntries.length === 0) {
    console.error("[rango] No router files found in the provided paths");
    process.exit(1);
  }

  let discoverAndWriteRouteTypes: typeof import("../build/runtime-discovery.ts").discoverAndWriteRouteTypes;
  try {
    const mod = await import("../build/runtime-discovery.ts");
    discoverAndWriteRouteTypes = mod.discoverAndWriteRouteTypes;
  } catch (err: any) {
    if (
      err.code === "ERR_MODULE_NOT_FOUND" ||
      err.code === "MODULE_NOT_FOUND"
    ) {
      console.error(
        "[rango] Runtime discovery requires 'vite' and '@vitejs/plugin-rsc'.\n" +
          "Install them with: pnpm add -D vite @vitejs/plugin-rsc",
      );
    } else {
      console.error(`[rango] Failed to load runtime discovery: ${err.message}`);
    }
    process.exit(1);
  }

  // Use a single project root for all routers (find from the first entry)
  const projectRoot = findProjectRoot(routerEntries[0]);

  for (const entry of routerEntries) {
    const result = await discoverAndWriteRouteTypes({
      root: projectRoot,
      configFile,
      entry,
    });
    console.log(
      `[rango] Runtime discovery: ${result.routerCount} router(s), ${result.routeCount} route(s)`,
    );
  }
}

function formatDiagnostics(
  diagnostics: Array<UnresolvableInclude & { routerFile: string }>,
) {
  for (const d of diagnostics) {
    const prefix = d.namePrefix ? `${d.namePrefix}.*` : `${d.pathPrefix}*`;
    console.error(`  ${prefix}`);
    console.error(`    Reason:  ${d.reason} -- ${d.detail}`);
    console.error(`    Source:  ${d.sourceFile}`);
  }
}
