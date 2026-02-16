import { resolve, dirname, extname } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { findTsFiles, writePerModuleRouteTypesForFile, writeCombinedRouteTypes } from "../build/generate-route-types.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "generate") {
  if (args.length === 0) {
    console.error("[rango] Usage: rango generate <file|dir> [file2 ...]");
    process.exit(1);
  }

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
      console.warn(`[rango] Failed to process ${filePath}: ${(err as Error).message}`);
    }
  }

  // Generate named-routes for any detected router files
  for (const routerFile of routerFiles) {
    writeCombinedRouteTypes(dirname(routerFile), [routerFile]);
  }

  console.log(`[rango] Processed ${files.length} file(s)${routerFiles.length ? ` (${routerFiles.length} router)` : ""}`);
  process.exit(0);
} else {
  console.log(`Usage: rango generate <file|dir> [file2 ...]

  Auto-detects file type (createRouter, urls) and generates
  the appropriate .gen.ts route type files.

  Pass files, directories, or a mix of both.

Examples:
  rango generate src/urls.tsx
  rango generate src/router.tsx src/urls.tsx
  rango generate src/`);
  process.exit(command ? 1 : 0);
}
