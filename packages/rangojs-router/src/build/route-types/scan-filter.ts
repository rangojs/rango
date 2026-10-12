import { isAbsolute, join, relative } from "node:path";
import { readdirSync } from "node:fs";
// @ts-ignore -- picomatch ships no .d.ts; types are trivial
import picomatch from "picomatch";

/** Default exclude patterns for route type scanning. */
export const DEFAULT_EXCLUDE_PATTERNS: string[] = [
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/dist/**",
  "**/coverage/**",
  "**/*.test.{ts,tsx,js,jsx}",
  "**/*.spec.{ts,tsx,js,jsx}",
];

export type ScanFilter = (absolutePath: string) => boolean;

/**
 * Compile include/exclude glob patterns into a single predicate.
 * Paths are made root-relative before matching.
 * Returns undefined when no filtering is needed (no include, default exclude).
 */
export function createScanFilter(
  root: string,
  opts: { include?: string[]; exclude?: string[] },
): ScanFilter | undefined {
  const { include, exclude } = opts;
  const hasInclude = include && include.length > 0;
  const hasCustomExclude = exclude !== undefined;

  if (!hasInclude && !hasCustomExclude) return undefined;

  const effectiveExclude = exclude ?? DEFAULT_EXCLUDE_PATTERNS;
  const includeMatcher = hasInclude ? picomatch(include) : null;
  const excludeMatcher =
    effectiveExclude.length > 0 ? picomatch(effectiveExclude) : null;

  return (absolutePath: string) => {
    const rel = relative(root, absolutePath);
    if (excludeMatcher && excludeMatcher(rel)) return false;
    if (includeMatcher) return includeMatcher(rel);
    return true;
  };
}

/**
 * Directory names no discovery scan enters: findTsFiles() and the router scans
 * (findRouterFiles/findHostRouterFiles, router-processing.ts) all build their
 * skip rule on this, so a file below one is never discovered. Dot-directories
 * cover a nested git worktree, a tool cache, or a test's working copy of
 * another app.
 */
export function isUniversallySkippedScanDir(name: string): boolean {
  return (
    name === "node_modules" ||
    name === "dist" ||
    name === "coverage" ||
    name.startsWith(".")
  );
}

/**
 * Whether a file under `root` sits in a directory every discovery scan skips
 * (isUniversallySkippedScanDir). The dev route-file watcher uses it to ignore
 * files discovery would never find. A path outside `root` is false.
 */
export function isInSkippedScanDir(
  root: string,
  absolutePath: string,
): boolean {
  const rel = relative(root, absolutePath);
  if (isAbsolute(rel)) return false;
  const dirs = rel.split(/[\\/]/).slice(0, -1);
  if (dirs[0] === "..") return false;
  return dirs.some(isUniversallySkippedScanDir);
}

/**
 * Directory names the source-file scans skip: findTsFiles() and the build
 * loader pre-scan (expose-internal-ids.ts). The isUniversallySkippedScanDir()
 * set plus `build`, which the router scans still enter.
 */
export function isSkippedSourceScanDir(name: string): boolean {
  return isUniversallySkippedScanDir(name) || name === "build";
}

/**
 * Recursively find .ts/.tsx files under a directory, skipping the directories
 * isSkippedSourceScanDir() names and .gen. files.
 */
export function findTsFiles(dir: string, filter?: ScanFilter): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(
      `[rango] Failed to scan directory ${dir}: ${(err as Error).message}`,
    );
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSkippedSourceScanDir(entry.name)) continue;
      results.push(...findTsFiles(fullPath, filter));
    } else if (
      (entry.name.endsWith(".ts") ||
        entry.name.endsWith(".tsx") ||
        entry.name.endsWith(".js") ||
        entry.name.endsWith(".jsx")) &&
      !entry.name.includes(".gen.")
    ) {
      if (filter && !filter(fullPath)) continue;
      results.push(fullPath);
    }
  }
  return results;
}
