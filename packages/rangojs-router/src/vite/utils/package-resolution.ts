/**
 * Package Resolution Utilities
 *
 * Handles detection of workspace vs npm install context and generates
 * appropriate aliases and exclude lists for Vite configuration.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import packageJson from "../../../package.json";

const require = createRequire(import.meta.url);

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
 * Subpaths derived from package.json exports that use TypeScript source.
 * These must be excluded from Vite's dependency optimization (they ship
 * as .ts/.tsx, not compiled JS) and aliased when installed from npm.
 *
 * Derived automatically from the exports field to prevent drift.
 */
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

/**
 * Generate the list of modules to exclude from Vite's dependency optimization.
 *
 * We include both the published name and the virtual name because
 * Vite's optimizer runs before alias resolution.
 */
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

/**
 * Subpaths that need aliasing — same as SOURCE_EXPORT_SUBPATHS.
 * When installed from npm, virtual entries may use a different package name
 * than the published one; aliases bridge them.
 */
const ALIAS_SUBPATHS = SOURCE_EXPORT_SUBPATHS;

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

/**
 * Plugin-rsc pushes bare specs like
 * `@vitejs/plugin-rsc/vendor/react-server-dom/client.edge` into
 * `optimizeDeps.include` for the ssr and rsc environments. In strict pnpm
 * consumer apps, `@vitejs/plugin-rsc` is only reachable from @rangojs/router's
 * node_modules, so Vite's optimizer — which resolves from the project root —
 * can't find them and emits "Failed to resolve dependency" warnings.
 *
 * We resolve those specs from this plugin's location (where plugin-rsc is
 * guaranteed to be installed as our dep) and expose them as `resolve.alias`
 * entries. The optimizer's resolver honors aliases, so the bare specs map to
 * absolute paths and resolve cleanly.
 */
export function getVendorAliases(): Record<string, string> {
  // client.browser is intentionally NOT aliased. plugin-rsc injects it into
  // the client env's optimizeDeps.include; Vite's manual-include path resolves
  // and pre-bundles regardless of optimizeDeps.exclude, so aliasing would
  // trigger esbuild pre-bundling of the CJS vendor file and bypass the
  // cjs-to-esm transform that patches `require('react'|'react-dom')` into
  // real ESM imports. The consumer may still see a single "Failed to resolve"
  // warning for client.browser; runtime resolution from plugin-rsc's own
  // importer works because Vite resolves relative to the importer (not root).
  const specs = [
    "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge",
    "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge",
  ];
  const aliases: Record<string, string> = {};
  for (const spec of specs) {
    try {
      aliases[spec] = require.resolve(spec);
    } catch {
      // Spec unresolvable (unexpected but non-fatal — Vite will warn as before).
    }
  }
  return aliases;
}
