"use client";

// Track prefetched URLs to avoid duplicate <link> elements
const prefetchedUrls = new Set<string>();

/**
 * Inject a <link rel="prefetch"> element into the document head
 * for the given URL with RSC partial request parameters.
 */
export function prefetchUrl(url: string, segmentIds: string[]): void {
  if (prefetchedUrls.has(url)) return;
  prefetchedUrls.add(url);

  // Build RSC partial URL with segment IDs
  const targetUrl = new URL(url, window.location.origin);
  targetUrl.searchParams.set("_rsc_partial", "true");
  if (segmentIds.length > 0) {
    targetUrl.searchParams.set("_rsc_segments", segmentIds.join(","));
  }

  // Inject <link rel="prefetch"> into head
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = targetUrl.toString();
  link.as = "fetch";
  document.head.appendChild(link);
}
