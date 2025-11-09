/**
 * RSC Framework Entry Point - Browser
 *
 * Handles client-side hydration and SPA navigation.
 * This entry point runs in the 'client' environment.
 *
 * Responsibilities:
 * - RSC stream deserialization (RSC stream → React VDOM)
 * - Client-side rendering and hydration
 * - SPA navigation with link interception
 * - Partial rendering with segment reconciliation
 * - Browser history management
 */

'use client';

import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  createTemporaryReferenceSet,
  encodeReply,
} from '@vitejs/plugin-rsc/browser';
import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { rscStream } from 'rsc-html-stream/client';
import type { RscPayload, SegmentMetadata } from './types';
import type { Segment } from '../segment-system';

// Navigation constants
const PARTIAL_PARAM = '_rsc_partial';
const PREV_PATH_PARAM = '_rsc_prev';
const RSC_ACTION_HEADER = 'x-rsc-action';

const LOG_PREFIX = '[Browser]';

// ============================================================================
// Navigation State Management
// ============================================================================

interface NavigationManager {
  currentPathname: string;
  segmentIds: string[];  // Track segment IDs (not full segments with components)
  abortController?: AbortController;
  setPayload: ((payload: RscPayload) => void) | null;
}

// ============================================================================
// Link Click Interception
// ============================================================================

/**
 * Determines if a link click should be intercepted for SPA navigation
 */
function shouldInterceptLink(link: Element | null, event: MouseEvent): boolean {
  if (
    !link ||
    !(link instanceof HTMLAnchorElement) ||
    !link.href ||
    (link.target && link.target !== '_self') ||
    link.origin !== location.origin ||
    link.hasAttribute('download') ||
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

/**
 * Sets up client-side navigation interception
 */
function setupNavigationInterception(
  manager: NavigationManager,
  onNavigation: () => void
): () => void {
  // Listen to browser navigation events
  window.addEventListener('popstate', onNavigation);

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
    const link = (event.target as Element).closest('a');

    if (shouldInterceptLink(link, event)) {
      event.preventDefault();
      history.pushState(null, '', (link as HTMLAnchorElement).href);
    }
  }

  document.addEventListener('click', handleClick);

  // Return cleanup function
  return () => {
    document.removeEventListener('click', handleClick);
    window.removeEventListener('popstate', onNavigation);
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
  };
}

// ============================================================================
// RSC Payload Fetching
// ============================================================================

/**
 * Creates fetch URL with partial rendering parameters
 */
function createFetchUrl(
  targetUrl: string,
  currentPathname: string,
  hasSegments: boolean
): URL {
  const url = new URL(targetUrl, window.location.origin);
  const targetPathname = url.pathname;

  const shouldAttemptPartial = currentPathname !== targetPathname && hasSegments;

  if (shouldAttemptPartial) {
    url.searchParams.set(PARTIAL_PARAM, 'true');
    url.searchParams.set(PREV_PATH_PARAM, currentPathname);
    console.log(`${LOG_PREFIX} → Requesting PARTIAL render`);
    console.log(`${LOG_PREFIX}   Previous: ${currentPathname}`);
    console.log(`${LOG_PREFIX}   Target: ${targetPathname}`);
  } else {
    console.log(`${LOG_PREFIX} → Requesting FULL render`);
    const reason =
      currentPathname === targetPathname ? 'Same path' : 'No segments';
    console.log(`${LOG_PREFIX}   Reason: ${reason}`);
  }

  return url;
}

/**
 * Fetches and processes RSC payload for navigation
 */
async function fetchRscPayload(
  manager: NavigationManager,
  targetUrl?: string
): Promise<void> {
  const url = targetUrl || window.location.href;
  const targetPathname = new URL(url, window.location.origin).pathname;

  console.log(`\n${LOG_PREFIX} ${'='.repeat(50)}`);
  console.log(`${LOG_PREFIX} NAVIGATION`);
  console.log(`${LOG_PREFIX} From: ${manager.currentPathname}`);
  console.log(`${LOG_PREFIX} To: ${targetPathname}`);

  // Build fetch URL
  const fetchUrl = createFetchUrl(url, manager.currentPathname, manager.segmentIds.length > 0);

  console.log(`${LOG_PREFIX} Fetching: ${fetchUrl.href}`);
  const startTime = Date.now();

  // Abort any in-flight requests
  manager.abortController?.abort('Cancelled due to new navigation');
  manager.abortController = new AbortController();

  try {
    const responsePromise = fetch(fetchUrl.href).catch((err) => {
      console.error(`${LOG_PREFIX} Fetch error:`, err);
      return new Response(null, { status: 500 });
    });

    const payload = await createFromFetch<RscPayload>(responsePromise, {
      signal: manager.abortController.signal,
    });

    if (!payload || manager.abortController.signal.aborted) {
      console.error(`${LOG_PREFIX} Fetch aborted or failed`);
      return;
    }

    const fetchTime = Date.now() - startTime;
    console.log(`${LOG_PREFIX} ✓ Response received in ${fetchTime}ms`);

    // Process payload
    if (payload.metadata?.segments) {
      console.log(`${LOG_PREFIX} Processing payload metadata...`);
      console.log(`${LOG_PREFIX}   Type: ${payload.metadata.isPartial ? 'PARTIAL' : 'FULL'}`);
      console.log(`${LOG_PREFIX}   Segments: ${payload.metadata.segments.map(s => s.id).join(', ')}`);

      // Update tracked segment IDs
      manager.segmentIds = payload.metadata.segments.map(s => s.id);

      // Server already rendered the tree in payload.root
      // We just use it directly - no reconstruction needed!
      console.log(`${LOG_PREFIX} ✓ Using server-rendered tree`);
    }

    // Update state
    if (manager.setPayload) {
      manager.setPayload(payload);
    }
    manager.currentPathname = targetPathname;

    console.log(`${LOG_PREFIX} ✓ UI updated`);
    console.log(`${LOG_PREFIX} ${'='.repeat(50)}\n`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Navigation failed:`, error);
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
    console.log(`${LOG_PREFIX} Server callback invoked:`, id);

    const url = new URL(window.location.href);
    const temporaryReferences = createTemporaryReferenceSet();

    const payload = await createFromFetch<RscPayload>(
      fetch(url, {
        method: 'POST',
        body: await encodeReply(args, { temporaryReferences }),
        headers: { [RSC_ACTION_HEADER]: id },
      }),
      { temporaryReferences }
    );

    return payload.returnValue;
  });
}

// ============================================================================
// React Root Component
// ============================================================================

/**
 * Root component that manages RSC payload state
 */
function BrowserRoot({
  initialPayload,
  manager,
}: {
  initialPayload: RscPayload;
  manager: NavigationManager;
}) {
  const [payload, setPayload] = React.useState(initialPayload);

  React.useEffect(() => {
    manager.setPayload = setPayload;
  }, [manager]);

  // Set up client-side navigation
  React.useEffect(() => {
    return setupNavigationInterception(manager, () => fetchRscPayload(manager));
  }, [manager]);

  return payload.root;
}

// ============================================================================
// HMR Support
// ============================================================================

/**
 * Sets up Hot Module Replacement for development
 */
function setupHMR(manager: NavigationManager): void {
  if (import.meta.hot) {
    import.meta.hot.on('rsc:update', () => {
      fetchRscPayload(manager);
    });
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Initialize and hydrate the browser application
 */
export async function initializeApp(): Promise<void> {
  console.log(`\n${LOG_PREFIX} ${'='.repeat(50)}`);
  console.log(`${LOG_PREFIX} INITIAL LOAD`);
  console.log(`${LOG_PREFIX} Path: ${window.location.pathname}`);

  // Load initial RSC payload from server-rendered stream
  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);

  // Initialize navigation manager with segment IDs (metadata only)
  const manager: NavigationManager = {
    currentPathname: window.location.pathname,
    segmentIds: initialPayload.metadata?.segments.map(s => s.id) || [],
    abortController: undefined,
    setPayload: null,
  };

  console.log(`${LOG_PREFIX} Initial segments: ${manager.segmentIds.join(', ')}`);
  console.log(`${LOG_PREFIX} Metadata:`, initialPayload.metadata);

  // Server already rendered the tree in initialPayload.root
  // No reconstruction needed - just use it!
  console.log(`${LOG_PREFIX} ✓ Using server-rendered tree`);
  console.log(`${LOG_PREFIX} ${'='.repeat(50)}\n`);

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

  console.log(`${LOG_PREFIX} ✓ Application hydrated and ready\n`);
}

// Auto-initialize on load
initializeApp();
