import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import packageJson from "../../../package.json";

const require = createRequire(import.meta.url);

/**
 * The canonical name used in virtual entries (without scope)
 */
const VIRTUAL_PACKAGE_NAME = "@rangojs/router";

export function getPublishedPackageName(): string {
  return packageJson.name;
}

export function isInstalledFromNpm(): boolean {
  const packageName = getPublishedPackageName();
  // Check if the scoped package exists in node_modules
  return existsSync(resolve(process.cwd(), "node_modules", packageName));
}

export function isWorkspaceDevelopment(): boolean {
  return !isInstalledFromNpm();
}

const SOURCE_EXPORT_SUBPATHS = Object.keys(packageJson.exports)
  .filter((key) => {
    const entry = (
      packageJson.exports as Record<string, Record<string, string>>
    )[key];
    // Include if any non-types condition points to TypeScript source
    return Object.entries(entry).some(
      ([condition, path]) =>
        condition !== "types" &&
        typeof path === "string" &&
        /\.tsx?$/.test(path),
    );
  })
  .map((key) => key.replace(/^\./, ""));

export function getExcludeDeps(): string[] {
  const packageName = getPublishedPackageName();
  const excludes: string[] = [];

  for (const subpath of SOURCE_EXPORT_SUBPATHS) {
    // Add scoped package paths
    excludes.push(`${packageName}${subpath}`);
    // Add virtual/aliased paths (before alias resolution)
    if (packageName !== VIRTUAL_PACKAGE_NAME) {
      excludes.push(`${VIRTUAL_PACKAGE_NAME}${subpath}`);
    }
  }

  return excludes;
}

const ALIAS_SUBPATHS = SOURCE_EXPORT_SUBPATHS;

export function getPackageAliases(): Record<string, string> {
  if (isWorkspaceDevelopment()) {
    return {};
  }

  const packageName = getPublishedPackageName();
  const aliases: Record<string, string> = {};

  for (const subpath of ALIAS_SUBPATHS) {
    aliases[`${VIRTUAL_PACKAGE_NAME}${subpath}`] = `${packageName}${subpath}`;
  }

  return aliases;
}

export function getVendorAliases(): Record<string, string> {
  const specs = [
    "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
    "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
  ];
  const aliases: Record<string, string> = {};
  for (const spec of specs) {
    try {
      aliases[spec] = require.resolve(spec);
    } catch {
      // Non-fatal; Vite will warn if it cannot resolve the spec
    }
  }
  return aliases;
}
