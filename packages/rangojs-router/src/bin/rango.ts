import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { findTsFiles, writePerModuleRouteTypesForFile, writeCombinedRouteTypes } from "../build/generate-route-types.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "generate") {
  const file = args[0];
  if (!file) {
    console.error("[rango] Usage: rango generate <file>");
    process.exit(1);
  }
  const resolvedPath = resolve(file);
  console.log(`[rango] Generating route types for ${resolvedPath}`);

  // Generate per-module types (follows includes recursively)
  writePerModuleRouteTypesForFile(resolvedPath);

  // If this is a router file, also generate named-routes types
  try {
    const source = readFileSync(resolvedPath, "utf-8");
    if (/\bcreateRouter\s*[<(]/.test(source)) {
      writeCombinedRouteTypes(dirname(resolvedPath), [resolvedPath]);
    }
  } catch {}

  process.exit(0);
} else if (command === "extract-names") {
  const dir = args[0] ?? "./src";
  const resolvedDir = resolve(dir);
  console.log(`[rango] Scanning ${resolvedDir} for url modules...`);

  const files = findTsFiles(resolvedDir);
  for (const filePath of files) {
    writePerModuleRouteTypesForFile(filePath);
  }

  console.log(`[rango] Scanned ${files.length} file(s)`);
  process.exit(0);
} else {
  console.log(`Usage: rango <command>

Commands:
  generate <file>      Generate .gen.ts route types for a single file
  extract-names [dir]  Extract route names from url modules (default: ./src)`);
  process.exit(command ? 1 : 0);
}
