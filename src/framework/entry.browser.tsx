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
import { OutletProvider } from "./router/Outlet";

// ============================================================================
// Types & Constants
// ============================================================================

export type Segment = {
  index: number;
  pattern: string;
  component: React.ReactNode;
  isLayout: boolean;
};

const LOG_PREFIX = "[Browser]";
const LOG_SEPARATOR = "============";

// Navigation constants
const PARTIAL_PARAM = "_rsc_partial";
const PREV_PATH_PARAM = "_rsc_prev";
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
 * Builds the tree from innermost (last) to outermost (first) segment.
 */
function reconstructTreeFromSegments(
  segments: Array<Segment>
): React.ReactNode {
  if (!segments || segments.length === 0) {
    return null;
  }

  let tree: React.ReactNode = null;

  // Build tree from first to last segment (outermost to innermost)
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    tree = React.createElement(OutletProvider, {
      content: tree,
      key: `outlet-${segment.index}`,
      children: segment.component,
    });
  }

  logger.info("Tree reconstruction complete");
  return tree;
}

/**
 * Merges new segments with existing ones for partial updates
 */
function mergeSegments(
  currentSegments: Segment[],
  newSegments: Segment[],
  startIndex: number
): Segment[] {
  // Preserve existing segments up to the start index
  const preservedSegments = currentSegments.filter((s) => s.index < startIndex);

  logger.info(
    `Preserving ${preservedSegments.length} segments before index ${startIndex}`
  );

  // Combine with new segments and sort by index
  const mergedSegments = [...preservedSegments, ...newSegments];
  mergedSegments.sort((a, b) => b.index - a.index);

  return mergedSegments;
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
}

/**
 * Creates a URL for fetching RSC payload with appropriate parameters
 */
function createFetchUrl(
  targetUrl: string,
  currentPathname: string,
  hasMetadata: boolean
): URL {
  const url = new URL(targetUrl, window.location.origin);
  const targetPathname = url.pathname;

  const shouldAttemptPartial =
    currentPathname !== targetPathname && hasMetadata;

  if (shouldAttemptPartial) {
    url.searchParams.set(PARTIAL_PARAM, "true");
    url.searchParams.set(PREV_PATH_PARAM, currentPathname);
    logger.info("→ Requesting PARTIAL render");
    logger.info(`  Previous: ${currentPathname}`);
    logger.info(`  Target: ${targetPathname}`);
  } else {
    logger.info("→ Requesting FULL render");
    const reason =
      currentPathname === targetPathname ? "Same path" : "No metadata";
    logger.info(`  Reason: ${reason}`);
  }

  return url;
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

  // Build fetch URL with partial rendering params
  const fetchUrl = createFetchUrl(
    url,
    manager.currentPathname,
    Boolean(manager.initialMetadata?.pathname)
  );

  logger.info(`Fetching: ${fetchUrl.href}`);
  const startTime = Date.now();

  // Abort any in-flight requests
  manager.abortController?.abort("Cancelled due to new navigation");
  manager.abortController = new AbortController();

  try {
    const responsePromise = fetch(fetchUrl.href).catch((err) => {
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
  if (payload.metadata?.isPartial && payload.metadata?.segments) {
    logger.info("Received PARTIAL payload with segments:");
    logger.info(`  Start index: ${payload.metadata.startIndex}`);
    logger.info(`  Preserved layouts: ${payload.metadata.preservedLayouts}`);

    // Log segment details
    payload.metadata.segments.forEach((seg: Segment) => {
      const type = seg.isLayout ? "layout" : "page";
      logger.info(`    - Index ${seg.index}: ${seg.pattern} (${type})`);
    });

    // Merge and reconstruct segments
    manager.currentSegments = mergeSegments(
      manager.currentSegments,
      payload.metadata.segments,
      payload.metadata.startIndex ?? 0
    );

    // Reconstruct tree from merged segments
    payload.root = reconstructTreeFromSegments(manager.currentSegments);
    logger.success("Tree reconstructed and payload updated");
  } else if (payload.metadata?.segments) {
    // Full payload with segments
    logger.info("Received FULL payload");
    manager.currentSegments = payload.metadata.segments || [];
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
  };

  logger.info("Initial payload metadata:", initialPayload.metadata);
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
