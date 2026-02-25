/**
 * Package Resolution Utilities
 *
 * Handles detection of workspace vs npm install context and generates
 * appropriate aliases and exclude lists for Vite configuration.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import packageJson from "../../../package.json" with { type: "json" };

/**
 * The canonical name used in virtual entries (without scope)
 */
const VIRTUAL_PACKAGE_NAME = "@rangojs/router";

/**
 * Get the published package name (e.g., "@rangojs/router")
 */
export function getPublishedPackageName(): string {
  return packageJson.name;
}

/**
 * Check if the package is installed from npm (scoped) vs workspace (unscoped)
 *
 * In workspace development:
 * - Package is installed as "@rangojs/router" via pnpm workspace alias
 * - The scoped name (@rangojs/router) doesn't exist in node_modules
 *
 * When installed from npm:
 * - Package is installed as "@rangojs/router"
 * - We need aliases to map "@rangojs/router/*" to "@rangojs/router/*"
 */
export function isInstalledFromNpm(): boolean {
  const packageName = getPublishedPackageName();
  // Check if the scoped package exists in node_modules
  return existsSync(resolve(process.cwd(), "node_modules", packageName));
}

/**
 * Check if we're in a monorepo/workspace development context
 */
export function isWorkspaceDevelopment(): boolean {
  return !isInstalledFromNpm();
}

/**
 * Subpaths that need to be excluded from Vite's dependency optimization
 * and potentially aliased
 */
const PACKAGE_SUBPATHS = [
  "",
  "/browser",
  "/client",
  "/server",
  "/rsc",
  "/ssr",
  "/internal/deps/browser",
  "/internal/deps/html-stream-client",
  "/internal/deps/ssr",
  "/internal/deps/rsc",
] as const;

/**
 * Generate the list of modules to exclude from Vite's dependency optimization.
 *
 * We include both the published name and the virtual name because
 * Vite's optimizer runs before alias resolution.
 */
export function getExcludeDeps(): string[] {
  const packageName = getPublishedPackageName();
  const excludes: string[] = [];

  for (const subpath of PACKAGE_SUBPATHS) {
    // Add scoped package paths
    excludes.push(`${packageName}${subpath}`);
    // Add virtual/aliased paths (before alias resolution)
    if (packageName !== VIRTUAL_PACKAGE_NAME) {
      excludes.push(`${VIRTUAL_PACKAGE_NAME}${subpath}`);
    }
  }

  return excludes;
}

/**
 * Subpaths that need aliasing (subset of PACKAGE_SUBPATHS)
 */
const ALIAS_SUBPATHS = [
  "/internal/deps/browser",
  "/internal/deps/ssr",
  "/internal/deps/rsc",
  "/internal/deps/html-stream-client",
  "/internal/deps/html-stream-server",
  "/browser",
  "/client",
  "/server",
  "/rsc",
  "/ssr",
] as const;

/**
 * Generate aliases to map virtual package paths to the actual published package.
 *
 * Only needed when installed from npm, where the package is under @rangojs/router
 * but virtual entries import from rsc-router/*.
 *
 * Returns empty object in workspace development where rsc-router resolves directly.
 */
export function getPackageAliases(): Record<string, string> {
  if (isWorkspaceDevelopment()) {
    // No aliases needed - rsc-router resolves directly
    return {};
  }

  const packageName = getPublishedPackageName();
  const aliases: Record<string, string> = {};

  for (const subpath of ALIAS_SUBPATHS) {
    aliases[`${VIRTUAL_PACKAGE_NAME}${subpath}`] = `${packageName}${subpath}`;
  }

  return aliases;
}
