/**
 * Client-side loader resolution.
 *
 * After the server returns segments during SPA navigation, segments flagged
 * with clientLoaderIds need their loader data resolved in the browser.
 * This module finds those segments, executes the registered client functions,
 * and patches loaderData in-place before the tree is rendered.
 */

import type { ResolvedSegment, ClientLoaderContext } from "../types.js";
import { getClientLoader } from "./client-loader-registry.js";

/**
 * Resolve client-side loaders for segments that have clientLoaderIds.
 * Mutates segments in-place by patching their loaderData.
 *
 * @param segments - All segments for the current navigation
 * @param url - The navigation target URL
 * @param signal - AbortSignal for cancellation
 */
export async function resolveClientLoaders(
  segments: ResolvedSegment[],
  url: URL,
  signal?: AbortSignal,
): Promise<void> {
  const pendingSegments = segments.filter(
    (s) => s.clientLoaderIds && s.clientLoaderIds.length > 0,
  );

  if (pendingSegments.length === 0) return;

  const params = pendingSegments[0]?.params ?? {};
  const ctx: ClientLoaderContext = {
    params,
    searchParams: url.searchParams,
    pathname: url.pathname,
    url,
    signal: signal ?? new AbortController().signal,
  };

  const promises: Promise<void>[] = [];

  for (const segment of pendingSegments) {
    for (const loaderId of segment.clientLoaderIds!) {
      const clientFn = getClientLoader(loaderId);
      if (!clientFn) {
        console.warn(
          `[client-loader] No client function registered for loader "${loaderId}". ` +
          `Ensure the loader module is imported in the browser bundle.`,
        );
        continue;
      }

      promises.push(
        Promise.resolve(clientFn(ctx)).then((data) => {
          // Patch loaderData onto the segment. If multiple client loaders
          // exist on the same segment, each one writes its own loaderId key.
          if (!segment.loaderData || segment.loaderData === null) {
            segment.loaderData = {};
          }
          // For wrapped loader results (from server), we need to match the
          // LoaderDataResult shape so useLoader can read them consistently.
          segment.loaderData = {
            __loaderResult: true,
            ok: true,
            data,
          };
          // Remove from clientLoaderIds after resolution
          segment.clientLoaderIds = segment.clientLoaderIds!.filter(
            (id) => id !== loaderId,
          );
        }),
      );
    }
  }

  await Promise.all(promises);
}
