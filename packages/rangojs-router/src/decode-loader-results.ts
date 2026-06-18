import type { ReactNode } from "react";
import { isLoaderDataResult } from "./types.js";

// Shared by segment-system (server) and LoaderResolver (client) so the
// legacy/ok/error-fallback/throw decode of resolved loader values lives once.
// Last failing loader wins errorFallback; an error without a fallback throws.
export function decodeLoaderResults(
  resolvedData: any[],
  loaderIds: string[],
): { loaderData: Record<string, any>; errorFallback: ReactNode } {
  const loaderData: Record<string, any> = {};
  let errorFallback: ReactNode = null;

  for (let i = 0; i < loaderIds.length; i++) {
    const id = loaderIds[i];
    const result = resolvedData[i];

    if (!isLoaderDataResult(result)) {
      loaderData[id] = result;
      continue;
    }

    if (result.ok) {
      loaderData[id] = result.data;
      continue;
    }

    // null/undefined is the producer's ONLY "no boundary found" sentinel
    // (loader-resolution.ts sets fallback: null for the no-boundary and the
    // fallback-render-threw cases). A matched boundary's rendered ReactNode can
    // legitimately be falsy (0, "", false), so test for null explicitly rather
    // than truthiness, otherwise a valid falsy fallback is discarded and the
    // original loader error is rethrown.
    if (result.fallback != null) {
      errorFallback = result.fallback;
    } else {
      // No boundary: rethrow preserving the ErrorInfo identity (name/stack/
      // code/cause) instead of a stripped generic Error.
      const info = result.error;
      const err = new Error(
        info.message,
        info.cause !== undefined ? { cause: info.cause } : undefined,
      );
      if (info.name) err.name = info.name;
      if (info.stack) err.stack = info.stack;
      if (info.code !== undefined) (err as { code?: string }).code = info.code;
      throw err;
    }
  }

  return { loaderData, errorFallback };
}
