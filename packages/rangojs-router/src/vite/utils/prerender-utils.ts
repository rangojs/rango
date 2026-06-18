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

import { escapeRegExp } from "../../regex-escape.js";

export function encodePathParam(value: unknown): string {
  return String(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function substituteRouteParams(
  pattern: string,
  params: Record<string, string>,
  encode: (value: string) => string = encodeURIComponent,
): string {
  let result = pattern;
  let hadOmittedOptional = false;

  for (const [key, value] of Object.entries(params)) {
    const escaped = escapeRegExp(key);
    if (value === "") {
      result = result.replace(
        new RegExp(`:${escaped}(\\([^)]*\\))?(?!\\?)`),
        "",
      );
      result = result.replace(`*${key}`, "");
    } else {
      result = result.replace(
        new RegExp(`:${escaped}(\\([^)]*\\))?\\??`),
        encode(value),
      );
      result = result.replace(`*${key}`, encode(value));
    }
  }

  result = result.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)(\([^)]*\))?\?/g, () => {
    hadOmittedOptional = true;
    return "";
  });

  if (hadOmittedOptional) {
    const hadTrailingSlash = pattern.length > 1 && pattern.endsWith("/");
    result = result.replace(/\/\/+/g, "/").replace(/\/+$/, "") || "/";
    if (hadTrailingSlash && !result.endsWith("/")) result += "/";
  }

  return result;
}

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

/**
 * Resolve a thrown build-time render error into the prerender build's policy and
 * log a per-entry line. A `Skip` (or any render error under `prerender.onError:
 * "warn"`) logs and returns so the caller skips the entry; a render error under
 * the default "fail" logs FAIL, notifies `onError`, and re-throws to fail the
 * build. Shared by `expandPrerenderRoutes` (prerender) and `renderStaticHandlers`
 * (static) so the Skip/warn/fail policy lives in one place. `label` is the padded
 * URL / handler name for the log line; `elapsed` is the per-entry duration string.
 */
export function resolvePrerenderError(
  registry: Map<string, any>,
  error: any,
  onError: "fail" | "warn",
  label: string,
  elapsed: string,
  phase: "prerender" | "static",
  routeKey?: string,
  pathname?: string,
): void {
  const isSkip = error?.name === "Skip";
  if (isSkip || onError === "warn") {
    if (isSkip) {
      console.log(`[rango]   SKIP ${label} (${elapsed}ms) - ${error.message}`);
    } else {
      console.warn(
        `[rango]   WARN ${label} (${elapsed}ms) - render error, not pre-rendered (prerender.onError: "warn"): ${error.message}`,
      );
    }
    notifyOnError(registry, error, phase, routeKey, pathname, true);
    return;
  }
  console.error(`[rango]   FAIL ${label} (${elapsed}ms) - ${error.message}`);
  notifyOnError(registry, error, phase, routeKey, pathname);
  throw error;
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
