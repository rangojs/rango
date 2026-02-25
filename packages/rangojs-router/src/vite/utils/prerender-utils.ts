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
