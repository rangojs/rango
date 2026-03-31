import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

/**
 * Escape special RegExp characters in a string for safe interpolation
 * into new RegExp() patterns.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Encode route param values for path interpolation while preserving path
 * separators for wildcard params (splat-style values can include `/`).
 */
export function encodePathParam(value: unknown): string {
  return String(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Substitute route params into a pattern, stripping constraint and optional
 * syntax (:param(a|b)? -> value). Also handles wildcard params (*key).
 * Optional params not present in `params` are removed from the output.
 */
export function substituteRouteParams(
  pattern: string,
  params: Record<string, string>,
  encode: (value: string) => string = encodeURIComponent,
): string {
  let result = pattern;
  let hadOmittedOptional = false;

  // First pass: substitute provided params
  for (const [key, value] of Object.entries(params)) {
    const escaped = escapeRegExp(key);
    result = result.replace(
      new RegExp(`:${escaped}(\\([^)]*\\))?\\??`),
      encode(value),
    );
    result = result.replace(`*${key}`, encode(value));
  }

  // Second pass: strip remaining optional param placeholders not in params
  result = result.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)(\([^)]*\))?\?/g, () => {
    hadOmittedOptional = true;
    return "";
  });

  // Clean up slashes from omitted optional segments
  if (hadOmittedOptional) {
    result = result.replace(/\/\/+/g, "/").replace(/\/+$/, "") || "/";
  }

  return result;
}

/**
 * Run an async function over items with bounded concurrency.
 * Errors propagate immediately and abort remaining work.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  if (limit <= 1) {
    for (const item of items) await fn(item);
    return;
  }
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
}

/**
 * Group prerender entries by their concurrency setting so each group
 * can be rendered with the appropriate parallelism.
 */
export function groupByConcurrency<T extends { concurrency: number }>(
  entries: T[],
): { concurrency: number; entries: T[] }[] {
  const map = new Map<number, T[]>();
  for (const entry of entries) {
    const key = entry.concurrency;
    let group = map.get(key);
    if (!group) {
      group = [];
      map.set(key, group);
    }
    group.push(entry);
  }
  return Array.from(map.entries(), ([concurrency, items]) => ({
    concurrency,
    entries: items,
  }));
}

/**
 * Notify all routers' onError callbacks about a build-time error.
 * Uses a synthetic request since there is no real request during build.
 */
export function notifyOnError(
  registry: Map<string, any>,
  error: unknown,
  phase: "prerender" | "static",
  routeKey?: string,
  pathname?: string,
  skipped?: boolean,
): void {
  for (const [, routerInstance] of registry) {
    const onError = routerInstance.onError;
    if (!onError) continue;

    const errorObj = error instanceof Error ? error : new Error(String(error));
    const syntheticUrl = new URL("http://prerender" + (pathname || "/"));
    const context = {
      error: errorObj,
      phase,
      request: new Request(syntheticUrl),
      url: syntheticUrl,
      pathname: syntheticUrl.pathname,
      method: "GET",
      routeKey,
      metadata: skipped ? { skipped: true } : undefined,
    };

    try {
      const result = onError(context);
      if (result instanceof Promise) {
        result.catch((cbErr: unknown) => {
          console.error(`[Build.onError] Callback error:`, cbErr);
        });
      }
    } catch (cbErr) {
      console.error(`[Build.onError] Callback error:`, cbErr);
    }
    break; // Only notify the first router with onError
  }
}

function getStagedAssetDir(projectRoot: string): string {
  return resolve(projectRoot, "node_modules/.rangojs-router-build/rsc-assets");
}

export function resetStagedBuildAssets(projectRoot: string): void {
  rmSync(getStagedAssetDir(projectRoot), { recursive: true, force: true });
}

export function stageBuildAssetModule(
  projectRoot: string,
  prefix: "__pr" | "__st",
  exportValue: string,
): string {
  const stagedDir = getStagedAssetDir(projectRoot);
  mkdirSync(stagedDir, { recursive: true });

  const contentHash = createHash("sha256")
    .update(exportValue)
    .digest("hex")
    .slice(0, 8);
  const fileName = `${prefix}-${contentHash}.js`;
  const filePath = resolve(stagedDir, fileName);

  if (!existsSync(filePath)) {
    writeFileSync(filePath, `export default ${exportValue};\n`);
  }

  return fileName;
}

export function copyStagedBuildAssets(
  projectRoot: string,
  fileNames: Iterable<string>,
): number {
  const stagedDir = getStagedAssetDir(projectRoot);
  const distAssetsDir = resolve(projectRoot, "dist/rsc/assets");
  mkdirSync(distAssetsDir, { recursive: true });

  let totalBytes = 0;
  for (const fileName of new Set(fileNames)) {
    const stagedPath = resolve(stagedDir, fileName);
    const distPath = resolve(distAssetsDir, fileName);
    copyFileSync(stagedPath, distPath);
    totalBytes += statSync(stagedPath).size;
  }

  return totalBytes;
}
