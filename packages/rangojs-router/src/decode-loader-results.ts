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

    if (result.fallback) {
      errorFallback = result.fallback;
    } else {
      throw new Error(result.error.message);
    }
  }

  return { loaderData, errorFallback };
}
