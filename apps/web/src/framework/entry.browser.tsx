import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  createTemporaryReferenceSet,
  encodeReply,
} from "@vitejs/plugin-rsc/browser";
import React from "react";
import { hydrateRoot } from "react-dom/client";
import { rscStream } from "rsc-html-stream/client";
import type { RscPayload } from "./entry.rsc";
import { OutletProvider, type Segment } from "rsc-router";

// ============================================================================
// Types & Constants
// ============================================================================

const LOG_PREFIX = "[Browser]";
const LOG_SEPARATOR = "============";

// Navigation constants
const HAS_PARAM = "_has"; // Client reports which segments it has
const RSC_ACTION_HEADER = "x-rsc-action";

// ============================================================================
// Logging Utilities
// ============================================================================

const logger = {
  info: (message: string, ...args: any[]) => {
    console.log(`${LOG_PREFIX} ${message}`, ...args);
  },

  section: (title: string) => {
    console.group(`\n${LOG_PREFIX} ${LOG_SEPARATOR} ${title} ${LOG_SEPARATOR}`);
  },

  endSection: () => {
    console.groupEnd();
  },

  error: (message: string, error?: any) => {
    console.log(`${LOG_PREFIX} ✗ ${message}`, error || "");
  },

  success: (message: string, ...args: any[]) => {
    console.log(`${LOG_PREFIX} ✓ ${message}`, ...args);
  },
};

// ============================================================================
// Tree Reconstruction Utilities
// ============================================================================

/**
 * Reconstructs a React component tree from an array of segments.
 * Builds the tree from innermost (page) to outermost (root layout).
 * Uses component cache to preserve React instances for unchanged segments.
 */
function reconstructTreeFromSegments(
  segments: Array<Segment>,
  componentCache: Map<string, React.ReactNode>
): React.ReactNode {
  if (!segments || segments.length === 0) {
    return null;
  }

  // Sort segments by index descending (innermost to outermost)
  const sortedSegments = [...segments].sort((a, b) => b.index - a.index);

  logger.info(`Reconstructing tree from ${sortedSegments.length} segments`);
  sortedSegments.forEach((seg) => {
    logger.info(
      `  - index ${seg.index}: ${seg.pattern} (${seg.isLayout ? "layout" : "page"})`
    );
  });

  // Start with the innermost page component
  let tree: React.ReactNode = null;

  for (const segment of sortedSegments) {
    const cacheKey = segment.id;

    if (segment.isLayout) {
      // Check if we have a cached version of this layout
      const cachedComponent = componentCache.get(cacheKey);

      if (cachedComponent && segment.id.startsWith("L")) {
        // Reuse cached layout component for unchanged layouts
        logger.info(`  Reusing cached layout: ${segment.id}`);
        tree = React.createElement(OutletProvider, {
          content: tree,
          key: segment.id,
          children: cachedComponent,
        });
      } else {
        // Create new component and cache it
        logger.info(`  Creating new component: ${segment.id}`);
        const newComponent = segment.component;
        componentCache.set(cacheKey, newComponent);

        tree = React.createElement(OutletProvider, {
          content: tree,
          key: segment.id,
          children: newComponent,
        });
      }
    } else {
      // Page component - always create new (pages change on navigation)
      logger.info(`  Creating new page component: ${segment.id}`);
      componentCache.set(cacheKey, segment.component);

      tree = React.createElement("div", {
        key: segment.id,
        children: segment.component,
      });
    }
  }

  logger.info("Tree reconstruction complete");
  return tree;
}

// ============================================================================
// Navigation Management
// ============================================================================

/**
 * Sets up client-side navigation interception
 */
function setupNavigationInterception(onNavigation: () => void): () => void {
  // Listen to browser navigation events
  window.addEventListener("popstate", onNavigation);

  // Override history methods
  const originalPushState = window.history.pushState;
  window.history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    onNavigation();
    return result;
  };

  const originalReplaceState = window.history.replaceState;
  window.history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    onNavigation();
    return result;
  };

  // Intercept link clicks for SPA navigation
  function handleClick(event: MouseEvent) {
    const link = (event.target as Element).closest("a");

    if (shouldInterceptLink(link, event)) {
      event.preventDefault();
      history.pushState(null, "", (link as HTMLAnchorElement).href);
    }
  }

  document.addEventListener("click", handleClick);

  // Return cleanup function
  return () => {
    document.removeEventListener("click", handleClick);
    window.removeEventListener("popstate", onNavigation);
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
  };
}

/**
 * Determines if a link click should be intercepted for SPA navigation
 */
function shouldInterceptLink(link: Element | null, event: MouseEvent): boolean {
  if (
    !link ||
    !(link instanceof HTMLAnchorElement) ||
    !link.href ||
    (link.target && link.target !== "_self") ||
    link.origin !== location.origin ||
    link.hasAttribute("download") ||
    event.button !== 0 || // Only left clicks
    event.metaKey || // Open in new tab (Mac)
    event.ctrlKey || // Open in new tab (Windows)
    event.altKey || // Download
    event.shiftKey ||
    event.defaultPrevented
  ) {
    return false;
  }

  return true;
}

// ============================================================================
// RSC Payload Management
// ============================================================================

interface PayloadManager {
  currentPathname: string;
  currentSegments: Segment[];
  abortController?: AbortController;
  setPayload: ((payload: RscPayload) => void) | null;
  initialMetadata?: RscPayload["metadata"];
  componentCache: Map<string, React.ReactNode>; // Cache components by segment ID
}

/**
 * Creates a URL for fetching RSC payload with appropriate parameters
 */
function createFetchUrl(
  targetUrl: string,
  currentSegments: Segment[]
): { url: URL; isPartialRequest: boolean } {
  const url = new URL(targetUrl, window.location.origin);
  let isPartialRequest = false;

  // If we have segments from a previous render, send them for differential rendering
  if (currentSegments.length > 0) {
    // Report which segments we currently have
    const segmentIds = currentSegments.map((s) => s.id).join(",");
    url.searchParams.set(HAS_PARAM, segmentIds);
    isPartialRequest = true;
    logger.info("→ Requesting PARTIAL render");
    logger.info(`  Has segments: ${segmentIds}`);
  } else {
    logger.info("→ Requesting FULL render");
    logger.info(`  Reason: No current segments`);
  }

  return { url, isPartialRequest };
}

/**
 * Fetches and processes RSC payload
 */
async function fetchRscPayload(
  manager: PayloadManager,
  targetUrl?: string
): Promise<void> {
  const url = targetUrl || window.location.href;
  const targetPathname = new URL(url, window.location.origin).pathname;

  logger.section("NAVIGATION");
  logger.info(`From: ${manager.currentPathname}`);
  logger.info(`To: ${targetPathname}`);

  // Build fetch URL with _has parameter
  const { url: fetchUrl, isPartialRequest } = createFetchUrl(
    url,
    manager.currentSegments
  );

  logger.info(`Fetching: ${fetchUrl.href}`);
  const startTime = Date.now();

  // Abort any in-flight requests
  manager.abortController?.abort("Cancelled due to new navigation");
  manager.abortController = new AbortController();

  try {
    // Set appropriate Accept header
    const headers: Record<string, string> = {
      Accept: isPartialRequest ? "text/x-component" : "text/html",
    };

    logger.info(`Accept header: ${headers.Accept}`);

    const responsePromise = fetch(fetchUrl.href, { headers }).catch((err) => {
      logger.error("Fetch error:", err);
      return new Response(null, { status: 500 });
    });

    const payload = await createFromFetch<RscPayload>(responsePromise, {
      signal: manager.abortController.signal,
    });

    if (!payload || manager.abortController.signal.aborted) {
      logger.error("Fetch aborted or failed");
      logger.endSection();
      return;
    }

    const fetchTime = Date.now() - startTime;
    logger.success(`Response received in ${fetchTime}ms`);

    // Process the payload
    processPayload(manager, payload);

    // Update state
    if (manager.setPayload) {
      manager.setPayload(payload);
    }
    manager.currentPathname = targetPathname;

    logger.success("UI updated");
  } catch (error) {
    logger.error("Navigation failed:", error);
  } finally {
    logger.endSection();
  }
}

/**
 * Processes received payload and handles partial updates
 */
function processPayload(manager: PayloadManager, payload: RscPayload): void {
  if (payload.metadata?.isPartial && payload.metadata?.updates) {
    logger.info("Received PARTIAL payload with updates:");

    // Server sent us a list of segment IDs that should exist,
    // and the actual updated segments
    const serverSegments = payload.metadata.segments || [];
    const updates = payload.metadata.updates || [];

    logger.info(
      `  Server segment IDs: ${serverSegments.map((s) => s.id).join(", ")}`
    );
    logger.info(`  Updated segments: ${updates.map((s) => s.id).join(", ")}`);

    // Create a map of segment IDs that should exist
    const shouldExist = new Set(serverSegments.map((s) => s.id));

    // Remove segments that shouldn't exist anymore
    manager.currentSegments = manager.currentSegments.filter((s) => {
      if (shouldExist.has(s.id)) {
        logger.info(`  ${s.id}: KEEP - still needed`);
        return true;
      } else {
        logger.info(`  ${s.id}: REMOVE - no longer needed`);
        return false;
      }
    });

    // Add or update segments from the updates array
    // IMPORTANT: Only replace segments that are in the updates array
    // This preserves React component instances for unchanged segments
    for (const updateSeg of updates) {
      const existingIndex = manager.currentSegments.findIndex(
        (s) => s.id === updateSeg.id
      );

      if (existingIndex >= 0) {
        // Replace existing segment with new version
        logger.info(`  ${updateSeg.id}: REPLACE - updating with new version`);
        manager.currentSegments[existingIndex] = updateSeg;
      } else {
        // Add new segment (didn't exist before)
        logger.info(`  ${updateSeg.id}: ADD - new segment`);
        manager.currentSegments.push(updateSeg);
      }
    }

    // Sort by index to maintain proper order
    manager.currentSegments.sort((a, b) => a.index - b.index);

    // For partial updates, only reconstruct if we have actual changes
    // This preserves React component instances for unchanged layouts
    if (updates.length > 0) {
      // Clear cache entries for updated segments only
      updates.forEach((seg) => {
        manager.componentCache.delete(seg.id);
        logger.info(`  Cleared cache for updated segment: ${seg.id}`);
      });

      // Reconstruct the tree with cache
      payload.root = reconstructTreeFromSegments(
        manager.currentSegments,
        manager.componentCache
      );
      logger.success("Tree reconstructed with partial updates");
    } else {
      // No updates - keep existing tree
      logger.info("No segment updates - preserving existing tree");
    }
  } else if (payload.metadata?.segments) {
    // Full payload with segments
    logger.info("Received FULL payload with segments");
    manager.currentSegments = payload.metadata.segments || [];

    // Clear cache for full payload (all new components)
    manager.componentCache.clear();
    // Reconstruct tree from segments
    payload.root = reconstructTreeFromSegments(
      manager.currentSegments,
      manager.componentCache
    );
    logger.success("Tree reconstructed from segments");
  } else {
    logger.info("Received standard payload");
  }
}

// ============================================================================
// Server Function Support
// ============================================================================

/**
 * Configures server callback for React Server Components
 */
function setupServerCallback(): void {
  setServerCallback(async (id, args) => {
    logger.info("Server callback invoked", { id });

    const url = new URL(window.location.href);
    const temporaryReferences = createTemporaryReferenceSet();

    const payload = await createFromFetch<RscPayload>(
      fetch(url, {
        method: "POST",
        body: await encodeReply(args, { temporaryReferences }),
        headers: { [RSC_ACTION_HEADER]: id },
      }),
      { temporaryReferences }
    );

    return payload.returnValue;
  });
}

// ============================================================================
// React Components
// ============================================================================

/**
 * Root component that manages RSC payload state
 */
function BrowserRoot({
  initialPayload,
  manager,
}: {
  initialPayload: RscPayload;
  manager: PayloadManager;
}) {
  const [payload, setPayload] = React.useState(initialPayload);

  React.useEffect(() => {
    manager.setPayload = setPayload;
  }, [manager, setPayload]);

  // Set up client-side navigation
  React.useEffect(() => {
    return setupNavigationInterception(() => fetchRscPayload(manager));
  }, [manager]);

  return payload.root;
}

// ============================================================================
// Hot Module Replacement
// ============================================================================

/**
 * Sets up HMR for server code changes
 */
function setupHMR(manager: PayloadManager): void {
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", () => {
      fetchRscPayload(manager);
    });
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Initializes the browser application
 */
async function initializeApp(): Promise<void> {
  logger.section("INITIAL LOAD");
  logger.info(`Path: ${window.location.pathname}`);

  // Load initial RSC payload from server-rendered stream
  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);

  // Initialize payload manager
  const manager: PayloadManager = {
    currentPathname: window.location.pathname,
    currentSegments: initialPayload.metadata?.segments || [],
    abortController: undefined,
    setPayload: null,
    initialMetadata: initialPayload.metadata,
    componentCache: new Map(), // Initialize component cache
  };

  logger.info("Initial payload metadata:", initialPayload.metadata);

  // Reconstruct tree from segments if we have them
  if (
    initialPayload.metadata?.segments &&
    initialPayload.metadata.segments.length > 0
  ) {
    logger.info("Reconstructing initial tree from segments...");
    initialPayload.root = reconstructTreeFromSegments(
      manager.currentSegments,
      manager.componentCache
    );
    logger.success("Initial tree reconstructed");
  }

  logger.endSection();

  // Configure server callbacks
  setupServerCallback();

  // Create and hydrate React app
  const app = (
    <React.StrictMode>
      <BrowserRoot initialPayload={initialPayload} manager={manager} />
    </React.StrictMode>
  );

  hydrateRoot(document, app, {
    formState: initialPayload.formState,
  });

  // Set up HMR
  setupHMR(manager);
}

// Start the application
initializeApp();
