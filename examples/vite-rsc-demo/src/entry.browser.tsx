import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  encodeReply,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/browser";
import React, { startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { rscStream } from "rsc-html-stream/client";
import type { RscPayload } from "./entry.rsc.js";
import { renderSegments, type ResolvedSegment } from "rsc-router";

console.log("[Browser] Initializing...");

// ============================================================================
// Navigation Manager
// ============================================================================

interface NavigationManager {
  path: string;
  currentUrl: string;
  currentSegmentIds: string[];
  storedSegments: Map<string, ResolvedSegment>;
  setPayload:
    | ((payload: { root: React.ReactNode; metadata: any }) => void)
    | null;
}

const navigationManager: NavigationManager = {
  path: window.location.pathname,
  currentUrl: window.location.href,
  currentSegmentIds: [],
  storedSegments: new Map(),
  setPayload: null,
};
let abortControllers: AbortController[] = [];
function cleanUpForController(abortController: AbortController) {
  abortControllers = abortControllers.filter((ac) => ac !== abortController);
  abortController.abort();
  console.log(`[Browser] Clean up abort controller:`, abortControllers);
}
function abortAllControllersAndAdd(abortController: AbortController) {
  abortControllers.forEach((ac) => ac.abort());
  abortControllers = [];
  abortControllers.push(abortController);
  console.log(`[Browser] Aborted all controllers`);
}
// ============================================================================
// Server Action Callback
// ============================================================================

// Setup server action callback - React calls this when server actions are invoked
setServerCallback(async (id: string, args: any[]) => {
  const abortController = new AbortController();

  abortAllControllersAndAdd(abortController);

  console.log(`[Browser] Args:`, args, { abortControllers });

  // 1. Create temporary references for serialization
  const temporaryReferences = createTemporaryReferenceSet();

  // 2. Build action request URL with current segments
  const url = new URL(window.location.href);
  url.searchParams.set("_rsc_action", id);
  url.searchParams.set(
    "_rsc_segments",
    navigationManager.currentSegmentIds.join(",")
  );

  // 3. Encode arguments
  const encodedBody = await encodeReply(args, { temporaryReferences });

  console.log(
    `[Browser] Encoded body type:`,
    typeof encodedBody,
    encodedBody instanceof FormData
  );
  console.log(`[Browser] Sending action request to: ${url.href}`);
  console.log(
    `[Browser] Current segments: ${navigationManager.currentSegmentIds.join(
      ", "
    )}`
  );

  // 4. Send action request (don't await - pass promise to createFromFetch)
  const responsePromise = fetch(url, {
    method: "POST",
    headers: {
      "rsc-action": id,
      "X-RSC-Router-Client-Path": navigationManager.currentUrl,
      // Note: Don't set Content-Type if using FormData - browser will set it with boundary
    },
    body: encodedBody,
  });

  // 5. Deserialize response (MUST use same temporaryReferences)
  const payload = await createFromFetch<RscPayload>(responsePromise, {
    temporaryReferences,
  });

  console.log(`[Browser] Action response received:`, payload.metadata);

  // 6. Process same as partial navigation
  const { metadata, returnValue } = payload;
  const { matched, diff, segments, isPartial } = metadata || {};

  // Log action result
  if (returnValue) {
    console.log(`[Browser] Action result:`, returnValue);
    if (!returnValue.ok) {
      console.error(`[Browser] Action failed:`, returnValue.data);
    }
  }

  if (isPartial) {
    console.log(`[Browser] Processing partial update`);
    console.log(
      `[Browser] Server sent ${segments?.length || 0} segments in diff:`,
      diff
    );
    console.log(`[Browser] Server expects client to have:`, matched);
    console.log(
      `[Browser] Client storedSegments has ${navigationManager.storedSegments.size} entries:`,
      Array.from(navigationManager.storedSegments.keys())
    );

    // Store new segments
    segments?.forEach((segment: ResolvedSegment) => {
      console.log(`[Browser] Storing segment ${segment.id}`);
      navigationManager.storedSegments.set(segment.id, segment);
    });

    console.log(
      `[Browser] After storing, storedSegments has ${navigationManager.storedSegments.size} entries`
    );
    if (!matched) {
      console.log(`[Browser] Matched segments: ${matched.join(", ")}`);
      throw new Error("Test error after action"); // --- IGNORE ---
    }
    // Rebuild from matched (source of truth)
    const fullSegments = matched
      .map((id: string) => {
        const segment = navigationManager.storedSegments.get(id);
        if (!segment) {
          console.error(
            `[Browser] MISSING SEGMENT: ${id} not in storedSegments!`
          );
        }
        return segment;
      })
      .filter(Boolean) as ResolvedSegment[];

    console.log(
      `[Browser] Rebuilt ${fullSegments.length} segments from matched array`
    );

    // HMR resilience check
    if (fullSegments.length < matched.length) {
      console.warn(`[Browser] Missing segments after action, refetching...`);
      console.log(`[Browser] returnValue before refetch:`, returnValue);

      // Save return value before refetch
      const savedReturnValue = returnValue;

      // Refetch and update UI FIRST
      await fetchPartialUpdate(window.location.href, []);
      console.log(`[Browser] Refetch complete, now returning action result`);

      // Return action result AFTER UI is refreshed
      if (savedReturnValue && !savedReturnValue.ok) {
        throw savedReturnValue.data;
      }

      const dataToReturn = savedReturnValue?.data;
      console.log(`[Browser] Returning to React (HMR case):`, dataToReturn);
      return dataToReturn;
    }
    if (navigationManager.path !== metadata?.pathname) {
      console.warn(`[Browser] Path changed during action, skipping UI update`);
      cleanUpForController(abortController);
    }
    // Update state
    navigationManager.currentSegmentIds = matched!;

    const returnData = returnValue?.data;

    if (returnValue && !returnValue.ok) {
      throw returnValue.data;
    }

    if (abortController.signal.aborted) {
      cleanUpForController(abortController);
      console.log(`[Browser] ✓ Action aborted - skipping UI update`);
      return returnData;
    }
    // Prepare new tree
    const newTree = renderSegments(fullSegments);

    if (abortController.signal.aborted === false) {
      navigationManager.setPayload?.({ root: newTree, metadata });
      console.log(
        `[Browser] ✓ Action complete - UI updated (after action state committed)`
      );
    } else {
      console.log(`[Browser] ✓ Action aborted - skipping UI update`);
    }
    abortControllers = abortControllers.filter((ac) => ac !== abortController);
    console.log(`[Browser] Clean up abort controller:`, abortControllers);
    console.log(`[Browser] Returning to React:`, returnData);

    return returnData;
  } else {
    // Full update
    navigationManager.currentSegmentIds = matched || [];
    throw new Error(`[Browser] Full update after action is not supported yet`);
  }
});

console.log("[Browser] ✓ Server action callback registered");

// ============================================================================
// Fetch Partial Update
// ============================================================================

async function fetchPartialUpdate(
  targetUrl?: string,
  segmentIds?: string[],
  isRetry = false
) {
  const url = targetUrl || window.location.href;
  const segments = segmentIds ?? navigationManager.currentSegmentIds;

  console.log(`\n[Browser] >>> NAVIGATION`);
  console.log(`[Browser] From: ${navigationManager.currentUrl}`);
  console.log(`[Browser] To: ${url}`);
  console.log(`[Browser] Segments to send: ${segments.join(", ")}`);

  // Build fetch URL with partial rendering params
  const fetchUrl = new URL(url);
  fetchUrl.searchParams.set("_rsc_partial", "true");
  fetchUrl.searchParams.set("_rsc_segments", segments.join(","));

  console.log(`[Browser] Fetching: ${fetchUrl.pathname}${fetchUrl.search}`);

  /* Optimistically set the new path */
  navigationManager.path = window.location.pathname;
  // Fetch with previous URL header (don't await - pass promise to createFromFetch)
  const responsePromise = fetch(fetchUrl, {
    headers: {
      "X-RSC-Router-Client-Path": navigationManager.currentUrl,
    },
  });

  // Deserialize RSC payload
  const payload = await createFromFetch<RscPayload>(responsePromise);

  if (payload.metadata?.isPartial) {
    // Partial update - merge segments
    const { segments, matched, diff } = payload.metadata;
    console.log(`[Browser] Partial update - matched: ${matched?.join(", ")}`);
    console.log(`[Browser] Diff: ${diff?.join(", ")}`);

    // If diff is empty, nothing changed - skip update!
    if (!diff || diff.length === 0) {
      console.log(
        `[Browser] No changes - all revalidations returned false, keeping existing UI`
      );
      // Still update URL state
      navigationManager.currentUrl = url;
      navigationManager.path = window.location.pathname;
      console.log(`[Browser] ✓ Navigation complete (no re-render)\n`);
      return;
    }

    // Update stored segments with new ones
    segments?.forEach((segment: ResolvedSegment) => {
      navigationManager.storedSegments.set(segment.id, segment);
    });

    // Build full segment list by merging
    const matchedIds = matched || [];
    const fullSegments = matchedIds
      .map((id: string) => {
        const segment = navigationManager.storedSegments.get(id);
        if (!segment) {
          console.warn(`[Browser] Missing segment: ${id}`);
        }
        return segment;
      })
      .filter(Boolean) as ResolvedSegment[];

    // HMR RESILIENCE: Check if we're missing segments (React Refresh cleared state)
    // If any segments are missing, refetch with empty segment list (server sends all)
    if (fullSegments.length < matchedIds.length) {
      const missingCount = matchedIds.length - fullSegments.length;
      const missingIds = matchedIds.filter(
        (id: string) => !navigationManager.storedSegments.has(id)
      );

      // If this is already a retry, don't retry again - throw error instead
      if (isRetry) {
        throw new Error(
          `[Browser] Failed to fetch segments after retry. Missing: ${missingIds.join(
            ", "
          )}`
        );
      }

      console.warn(
        `[Browser] HMR detected: Missing ${missingCount} segments in storage. Refetching all segments...`
      );

      // Refetch with empty segments = tell server "I have nothing, send everything"
      return fetchPartialUpdate(url, [], true); // Recursive call with retry flag
    }

    console.log(
      `[Browser] Merged segments: ${fullSegments.map((s) => s.id).join(", ")}`
    );

    // Rebuild tree on client
    const newTree = renderSegments(fullSegments);

    // Update segment IDs
    navigationManager.currentSegmentIds = matchedIds;
    navigationManager.currentUrl = url;

    // Update UI
    navigationManager.setPayload?.({
      root: newTree,
      metadata: payload.metadata,
    });

    console.log(`[Browser] ✓ Navigation complete\n`);
  } else {
    // Full update (fallback)
    console.warn(`[Browser] Full update (fallback)`);
    navigationManager.currentSegmentIds =
      payload.metadata?.segments?.map((s: any) => s.id) || [];
    navigationManager.currentUrl = url;
    navigationManager.path = window.location.pathname;

    // Store all segments (metadata segments don't have components on initial load)
    // Just track IDs for now

    navigationManager.setPayload?.({
      root: payload.root,
      metadata: payload.metadata,
    });
  }
}

// ============================================================================
// Link Interception
// ============================================================================

function shouldInterceptLink(link: HTMLAnchorElement): boolean {
  // Only intercept same-origin links
  if (link.origin !== window.location.origin) {
    return false;
  }

  // Don't intercept if it has download attribute
  if (link.hasAttribute("download")) {
    return false;
  }

  // Don't intercept if target is set
  if (link.target && link.target !== "_self") {
    return false;
  }

  // Don't intercept if modifier keys are pressed
  if (link.getAttribute("data-no-intercept") === "true") {
    return false;
  }

  return true;
}

function setupLinkInterception() {
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const link = target.closest("a");

    if (!link || !shouldInterceptLink(link)) {
      return;
    }

    e.preventDefault();
    const href = link.href;

    // Update URL
    window.history.pushState({}, "", href);

    // Fetch partial update
    fetchPartialUpdate(href);
  });

  console.log("[Browser] ✓ Link interception enabled");
}

// ============================================================================
// Root Component
// ============================================================================

function BrowserRoot({ initialPayload }: { initialPayload: RscPayload }) {
  const [payload, setPayload] = React.useState(initialPayload);

  React.useEffect(() => {
    // Register setPayload callback
    navigationManager.setPayload = setPayload;

    // Setup link interception
    setupLinkInterception();

    // Setup popstate listener
    window.addEventListener("popstate", () => {
      fetchPartialUpdate();
    });

    console.log("[Browser] ✓ Ready for navigation");

    return () => {
      navigationManager.setPayload = null;
    };
  }, []);

  return payload.root;
}

// ============================================================================
// Initialize App
// ============================================================================

async function initializeApp() {
  console.log("[Browser] Loading initial payload...");

  // Get RSC stream from SSR-injected __FLIGHT_DATA__
  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);

  console.log("[Browser] Initial payload:", initialPayload.metadata);

  // Initialize navigation manager
  navigationManager.currentUrl = window.location.href;
  navigationManager.path = window.location.pathname;
  navigationManager.currentSegmentIds =
    initialPayload.metadata?.segments?.map((s: any) => s.id) || [];

  // Store initial segments WITH components in storedSegments
  // This is critical for partial rendering to work on first navigation/action
  initialPayload.metadata?.segments?.forEach((segment: ResolvedSegment) => {
    console.log(`[Browser] Storing initial segment: ${segment.id}`);
    navigationManager.storedSegments.set(segment.id, segment);
  });

  console.log(
    "[Browser] Initial segments:",
    navigationManager.currentSegmentIds.join(", ")
  );
  console.log(
    `[Browser] Stored ${navigationManager.storedSegments.size} segments for partial rendering`
  );

  // Hydrate
  const root = document.getElementById("root") || document;
  // Rebuild tree on client
  const newTree = (initialPayload.root = renderSegments(
    initialPayload.metadata!.segments
  ));
  hydrateRoot(
    root,
    <React.StrictMode>
      <BrowserRoot initialPayload={initialPayload} />
    </React.StrictMode>
  );

  // implement server HMR by triggering re-fetch/render of RSC upon server code change
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", () => {
      fetchPartialUpdate(location.href, []);
    });
  }

  console.log("[Browser] ✓ Hydrated\n");
}

// Start the app
initializeApp().catch((error) => {
  console.error("[Browser] Initialization error:", error);
});
