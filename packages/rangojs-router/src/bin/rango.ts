import { resolve } from "node:path";
import { findTsFiles, writePerModuleRouteTypesForFile } from "../build/generate-route-types.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "extract-names") {
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
  extract-names [dir]  Extract route names from url modules (default: ./src)`);
  process.exit(command ? 1 : 0);
}
