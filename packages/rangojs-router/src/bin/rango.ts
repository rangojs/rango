import { resolve, dirname } from "node:path";
import { readFileSync, statSync, existsSync } from "node:fs";
import {
  findTsFiles,
  writePerModuleRouteTypesForFile,
  writeCombinedRouteTypes,
  detectUnresolvableIncludes,
  detectUnresolvableIncludesForUrlsFile,
  findNestedRouterConflict,
  formatNestedRouterConflictError,
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
} else if (command === "mcp") {
  if (rawArgs[0] === "install") {
    let client: "claude-code" | "cursor" | "vscode" | "gemini" | undefined;
    let projectRoot = ".";
    let dryRun = false;

    for (let i = 1; i < rawArgs.length; i++) {
      const arg = rawArgs[i];
      if (arg === "--client") {
        const value = rawArgs[++i];
        if (
          value !== "claude-code" &&
          value !== "cursor" &&
          value !== "vscode" &&
          value !== "gemini"
        ) {
          console.error(
            "[rango] --client requires one of: claude-code, cursor, vscode, gemini",
          );
          process.exit(1);
        }
        client = value;
      } else if (arg === "--root") {
        const value = rawArgs[++i];
        if (!value) {
          console.error("[rango] --root requires a path argument");
          process.exit(1);
        }
        projectRoot = value;
      } else if (arg === "--dry-run") {
        dryRun = true;
      } else {
        console.error(`[rango] Unknown MCP install option: ${arg}`);
        process.exit(1);
      }
    }
    if (!client) {
      console.error(
        "[rango] Usage: rango mcp install --client <claude-code|cursor|vscode|gemini> [--root <path>] [--dry-run]",
      );
      process.exit(1);
    }

    import("../devtools-mcp/client-config-installer.js")
      .then(({ installRangoMcpClientConfig }) =>
        installRangoMcpClientConfig({
          workspaceRoot: process.cwd(),
          projectRoot,
          client,
          dryRun,
        }),
      )
      .then((result) => {
        const prefix = result.dryRun ? "Would be" : "MCP client config";
        console.log(`[rango] ${prefix} ${result.action}: ${result.configPath}`);
      })
      .catch((error: unknown) => {
        console.error(
          `[rango] MCP client install failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      });
  } else {
    let projectRoot = process.cwd();
    let instanceId: string | undefined;

    for (let i = 0; i < rawArgs.length; i++) {
      const arg = rawArgs[i];
      if (arg === "--root") {
        const value = rawArgs[++i];
        if (!value) {
          console.error("[rango] --root requires a path argument");
          process.exit(1);
        }
        projectRoot = resolve(value);
      } else if (arg === "--instance") {
        instanceId = rawArgs[++i];
        if (!instanceId) {
          console.error("[rango] --instance requires an ID argument");
          process.exit(1);
        }
      } else {
        console.error(`[rango] Unknown MCP option: ${arg}`);
        process.exit(1);
      }
    }

    import("../devtools-mcp/stdio-connector.js")
      .then(({ runRangoMcpConnector }) =>
        runRangoMcpConnector({ projectRoot, instanceId }),
      )
      .catch((error: unknown) => {
        console.error(
          `[rango] MCP connector failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      });
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
  console.log(`Usage:
  rango generate <file|dir> [file2 ...] [--runtime|--static] [--config <path>]
  rango mcp [--root <path>] [--instance <id>]
  rango mcp install --client <claude-code|cursor|vscode|gemini> [--root <path>] [--dry-run]

  Auto-detects file type (createRouter, urls) and generates
  the appropriate .gen.ts route type files.

Modes:
  (default)   Static parser with error on unresolvable includes
  --runtime   Vite-based runtime discovery (100% coverage)
              Requires vite and @vitejs/plugin-rsc
  --static    Static parser, accept partial output with warnings

Options:
  --config <path>  Path to vite.config.ts (--runtime only, auto-detected if omitted)
  --root <path>    Project root for MCP runtime discovery (defaults to cwd)
  --instance <id>  Select one dev server when multiple instances use the same root
  --client <name>  Install a project-local MCP config for a supported client
  --dry-run        Report the MCP config action without writing it

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

  // Phase 1: Classify files
  const routerFiles: string[] = [];
  const urlsFiles: string[] = [];

  for (const filePath of files) {
    try {
      const source = readFileSync(filePath, "utf-8");
      if (/\bcreateRouter\s*[<(]/.test(source)) {
        routerFiles.push(filePath);
      }
      if (source.includes("urls(")) {
        urlsFiles.push(filePath);
      }
    } catch (err) {
      console.warn(
        `[rango] Failed to process ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  // Phase 2: Collect diagnostics from all files BEFORE writing anything
  const allDiagnostics: Array<UnresolvableInclude & { routerFile: string }> =
    [];

  for (const routerFile of routerFiles) {
    const diagnostics = detectUnresolvableIncludes(routerFile);
    for (const d of diagnostics) {
      allDiagnostics.push({ ...d, routerFile });
    }
  }

  // Also check standalone urls files not covered by router-level detection
  const routerFileSet = new Set(routerFiles);
  for (const urlsFile of urlsFiles) {
    if (routerFileSet.has(urlsFile)) continue;
    const diagnostics = detectUnresolvableIncludesForUrlsFile(urlsFile);
    for (const d of diagnostics) {
      allDiagnostics.push({ ...d, routerFile: urlsFile });
    }
  }

  // Deduplicate diagnostics (router and urls detection may find the same issue)
  const seen = new Set<string>();
  const uniqueDiagnostics = allDiagnostics.filter((d) => {
    const key = `${d.sourceFile}:${d.pathPrefix}:${d.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (uniqueDiagnostics.length > 0 && mode === "default") {
    // Hard error: no files written
    console.error("\n[rango] Unresolvable includes detected:\n");
    formatDiagnostics(uniqueDiagnostics);
    console.error(
      "\nThe static parser cannot resolve these includes because they use " +
        "factory functions or dynamic expressions.\n\n" +
        "Options:\n" +
        "  rango generate <path> --runtime   Use Vite-based discovery (requires vite)\n" +
        "  rango generate <path> --static    Accept partial output (missing routes above)\n",
    );
    process.exit(1);
  }

  if (uniqueDiagnostics.length > 0 && mode === "static") {
    // Warning: partial output accepted
    console.warn(
      "\n[rango] Warning: partial output (unresolvable includes):\n",
    );
    formatDiagnostics(uniqueDiagnostics);
    console.warn("");
  }

  const nestedRouterConflict = findNestedRouterConflict(routerFiles);
  if (nestedRouterConflict) {
    console.error(
      `\n${formatNestedRouterConflictError(nestedRouterConflict, "[rango]")}\n`,
    );
    process.exit(1);
  }

  // Phase 3: Write all outputs (only reached if diagnostics pass or --static)
  for (const urlsFile of urlsFiles) {
    writePerModuleRouteTypesForFile(urlsFile);
  }

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

  const nestedRouterConflict = findNestedRouterConflict(routerEntries);
  if (nestedRouterConflict) {
    console.error(
      `\n${formatNestedRouterConflictError(nestedRouterConflict, "[rango]")}\n`,
    );
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

  for (const entry of routerEntries) {
    const projectRoot = findProjectRoot(entry);
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
